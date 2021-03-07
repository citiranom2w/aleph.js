import type { ImportMap, TransformOptions } from '../compiler/mod.ts'
import { buildChecksum, transform } from '../compiler/mod.ts'
import { colors, createHash, ensureDir, path, walk } from '../deps.ts'
import { EventEmitter } from '../framework/core/events.ts'
import type { RouteModule } from '../framework/core/routing.ts'
import { Routing, toPagePath } from '../framework/core/routing.ts'
import { defaultReactVersion, minDenoVersion, moduleExts, hashShortLength } from '../shared/constants.ts'
import { ensureTextFile, existsDirSync, existsFileSync } from '../shared/fs.ts'
import log from '../shared/log.ts'
import util from '../shared/util.ts'
import type { Config, LoaderPlugin, LoaderTransformResult, Module, DependencyDescriptor, RouterURL, ServerApplication, TransformFn } from '../types.ts'
import { VERSION } from '../version.ts'
import { Bundler } from './bundler.ts'
import { defaultConfig, loadConfig, loadImportMap } from './config.ts'
import { clearCompilation, computeHash, createHtml, formatBytesWithColor, getAlephPkgUri, getRelativePath, getDenoDir, isLoaderPlugin, reFullVersion, reHashJS, reHashResolve, toLocalUrl, trimModuleExt } from './helper.ts'
import { Renderer } from './renderer.ts'

/** The application class for aleph server. */
export class Application implements ServerApplication {
  readonly workingDir: string
  readonly mode: 'development' | 'production'
  readonly config: Required<Config>
  readonly importMap: ImportMap
  readonly ready: Promise<void>

  #dirs: Map<string, string> = new Map()
  #modules: Map<string, Module> = new Map()
  #pageRouting: Routing = new Routing({})
  #apiRouting: Routing = new Routing({})
  #fsWatchListeners: Array<EventEmitter> = []
  #bundler: Bundler = new Bundler(this)
  #renderer: Renderer = new Renderer(this)
  #renderCache: Map<string, Map<string, [string, any]>> = new Map()
  #injects = { compilation: new Array<TransformFn>(), hmr: new Array<TransformFn>() }
  #reloading = false

  constructor(workingDir = '.', mode: 'development' | 'production' = 'production', reload = false) {
    if (Deno.version.deno < minDenoVersion) {
      log.fatal(`need Deno ${minDenoVersion}+, but got ${Deno.version.deno}`)
    }
    this.workingDir = path.resolve(workingDir)
    this.mode = mode
    this.config = { ...defaultConfig }
    this.importMap = { imports: {}, scopes: {} }
    this.ready = this.init(reload)
  }

  /** initiate application */
  private async init(reload: boolean) {
    const t = performance.now()
    const alephPkgUri = getAlephPkgUri()
    const walkOptions = { includeDirs: false, skip: [/(^|\/|\\)\./, /\.d\.ts$/i, /(\.|_)(test|spec|e2e)\.(tsx?|jsx?|mjs)?$/i] }
    const [config, importMap, denoDir] = await Promise.all([
      loadConfig(this.workingDir),
      loadImportMap(this.workingDir),
      getDenoDir()
    ])

    Object.assign(this.config, config)
    Object.assign(this.importMap, importMap)

    // change current working directory to appDoot
    Deno.chdir(this.workingDir)

    // inject env variables
    Deno.env.set('ALEPH_VERSION', VERSION)
    Deno.env.set('BUILD_MODE', this.mode)
    this.#dirs.set('denoDir', denoDir)

    const buildManifestFile = path.join(this.buildDir, 'build.manifest.json')
    let shouldRebuild = !existsFileSync(buildManifestFile)
    if (!shouldRebuild) {
      try {
        const bm = JSON.parse(await Deno.readTextFile(buildManifestFile))
        shouldRebuild = bm.compiler !== buildChecksum
      } catch (e) { }
    }
    if (shouldRebuild) {
      log.debug('rebuild...')
      ensureTextFile(buildManifestFile, JSON.stringify({
        aleph: VERSION,
        compiler: buildChecksum,
        deno: Deno.version.deno,
      }, undefined, 2))
    }

    this.#reloading = reload
    if (reload || shouldRebuild) {
      if (existsDirSync(this.buildDir)) {
        await Deno.remove(this.buildDir, { recursive: true })
      }
      await ensureDir(this.buildDir)
    }

    // apply server plugins
    for (const plugin of this.config.plugins) {
      if (plugin.type === 'server') {
        await plugin.onInit(this)
      }
    }

    // init framework
    const { init } = await import(`../framework/${this.config.framework}/init.ts`)
    await init(this)

    log.info('Compiling...')

    // pre-compile framework modules
    await this.compile(`${alephPkgUri}/framework/${this.config.framework}/bootstrap.ts`)
    if (this.isDev) {
      await Promise.all(['hmr.ts', 'nomodule.ts'].map(name => {
        this.compile(`${alephPkgUri}/framework/core/${name}`)
      }))
    }

    // compile and import framework renderer when ssr is enable
    if (this.config.ssr) {
      await this.#renderer.load()
    }

    // compile custom components
    for (const name of ['app', '404', 'loading']) {
      for (const ext of moduleExts) {
        if (existsFileSync(path.join(this.srcDir, `${name}.${ext}`))) {
          await this.compile(`/${name}.${ext}`)
          break
        }
      }
    }

    // update page routing
    const pagesDir = path.join(this.srcDir, 'pages')
    if (!(existsDirSync(pagesDir))) {
      log.fatal(`'pages' directory not found.`)
    }
    this.#pageRouting.config(this.config)
    for await (const { path: p } of walk(pagesDir, walkOptions)) {
      const url = util.cleanPath('/pages/' + util.trimPrefix(p, pagesDir))
      let validated = moduleExts.some(ext => p.endsWith('.' + ext))
      if (!validated) {
        validated = this.config.plugins.some(p => p.type === 'loader' && p.test.test(url) && p.allowPage)
      }
      if (validated) {
        const { hash } = await this.compile(url)
        this.#pageRouting.update(this.createRouteModule(url, hash))
      }
    }

    // update api routing
    const apiDir = path.join(this.srcDir, 'api')
    if (existsDirSync(apiDir)) {
      for await (const { path: p } of walk(apiDir, { ...walkOptions, exts: moduleExts })) {
        const url = util.cleanPath('/api/' + util.trimPrefix(p, apiDir))
        let mod: Module
        if (this.isDev) {
          // in dev mode, we pre-compile the api code to support re-import the api module
          // when it is changed.
          mod = await this.compile(url)
        } else {
          mod = { url, hash: '', sourceHash: '', deps: [], jsFile: p }
          this.#modules.set(url, mod)
        }
        this.#apiRouting.update(this.createRouteModule(url, mod.hash))
      }
    }

    // pre-bundle
    if (!this.isDev) {
      await this.bundle()
    }

    // end reload
    if (reload) {
      this.#reloading = false
    }

    log.debug(`init project in ${Math.round(performance.now() - t)}ms`)

    if (this.isDev) {
      this.watch()
    }
  }

  /** watch file changes, re-compile modules and send HMR signal. */
  private async watch() {
    const w = Deno.watchFs(this.srcDir, { recursive: true })
    log.info('Start watching code changes...')
    for await (const event of w) {
      for (const p of event.paths) {
        const url = util.cleanPath(util.trimPrefix(p, this.srcDir))
        if (this.isScopedModule(url)) {
          util.debounceX(url, () => {
            if (existsFileSync(p)) {
              let type = 'modify'
              if (!this.#modules.has(url)) {
                type = 'add'
              }
              log.info(type, url)
              this.compile(url, { forceCompile: true }).then(mod => {
                const hmrable = this.isHMRable(mod.url)
                const update = ({ url, hash }: Module) => {
                  if (trimModuleExt(url) === '/app') {
                    this.#renderCache.clear()
                  } else if (url.startsWith('/pages/')) {
                    this.#renderCache.delete(toPagePath(url))
                    this.#pageRouting.update(this.createRouteModule(url, hash))
                  } else if (url.startsWith('/api/')) {
                    this.#apiRouting.update(this.createRouteModule(url, hash))
                  }
                }
                if (hmrable) {
                  if (type === 'add') {
                    this.#fsWatchListeners.forEach(e => e.emit('add', { url: mod.url, hash: mod.hash }))
                  } else {
                    this.#fsWatchListeners.forEach(e => e.emit('modify-' + mod.url, mod.hash))
                  }
                }
                update(mod)
                this.checkCompilationSideEffect(url, (mod) => {
                  update(mod)
                  if (!hmrable && this.isHMRable(mod.url)) {
                    this.#fsWatchListeners.forEach(w => w.emit('modify-' + mod.url, mod.hash))
                  }
                })
              }).catch(err => {
                log.error(`compile(${url}):`, err.message)
              })
            } else if (this.#modules.has(url)) {
              if (trimModuleExt(url) === '/app') {
                this.#renderCache.clear()
              } else if (url.startsWith('/pages/')) {
                this.#renderCache.delete(toPagePath(url))
                this.#pageRouting.removeRoute(toPagePath(url))
              } else if (url.startsWith('/api/')) {
                this.#apiRouting.removeRoute(toPagePath(url))
              }
              this.#modules.delete(url)
              if (this.isHMRable(url)) {
                this.#fsWatchListeners.forEach(e => e.emit('remove', url))
              }
              log.info('remove', url)
            }
          }, 150)
        }
      }
    }
  }

  get isDev() {
    return this.mode === 'development'
  }

  get srcDir() {
    return this.getDir('src', () => path.join(this.workingDir, this.config.srcDir))
  }

  get outputDir() {
    return this.getDir('output', () => path.join(this.workingDir, this.config.outputDir))
  }

  get buildDir() {
    return this.getDir('build', () => path.join(this.workingDir, '.aleph', this.mode))
  }

  /** returns the module by given url. */
  getModule(url: string): Module | null {
    if (this.#modules.has(url)) {
      return this.#modules.get(url)!
    }
    return null
  }

  findModuleByName(name: string): Module | null {
    for (const ext of moduleExts) {
      const url = `/${util.trimPrefix(name, '/')}.${ext}`
      if (this.#modules.has(url)) {
        return this.#modules.get(url)!
      }
    }
    return null
  }

  getPageRoute(location: { pathname: string, search?: string }): [RouterURL, RouteModule[]] {
    return this.#pageRouting.createRouter(location)
  }

  getAPIRoute(location: { pathname: string, search?: string }): [RouterURL, Module] | null {
    const router = this.#apiRouting.createRouter(location)
    if (router !== null) {
      const [url, nestedModules] = router
      const { url: moduleUrl } = nestedModules.pop()!
      return [url, this.#modules.get(moduleUrl)!]
    }
    return null
  }

  /** add a new page module by given path and source code. */
  async addModule(url: string, options: { code?: string, once?: boolean } = {}): Promise<Module> {
    const mod = await this.compile(url, { sourceCode: options.code })
    if (url.startsWith('/pages/')) {
      this.#pageRouting.update(this.createRouteModule(mod.url, mod.hash))
    } else if (url.startsWith('/api/')) {
      this.#apiRouting.update(this.createRouteModule(mod.url, mod.hash))
    }
    return mod
  }

  /** inject code */
  injectCode(stage: 'compilation' | 'hmr', transform: TransformFn): void {
    this.#injects[stage].push(transform)
  }

  async getSSRData(loc: { pathname: string, search?: string }): Promise<any> {
    if (!this.isSSRable(loc.pathname)) {
      return null
    }

    const [router, nestedModules] = this.#pageRouting.createRouter(loc)
    const { pagePath } = router
    if (pagePath === '') {
      return null
    }

    const cacheKey = router.pathname + router.query.toString()
    const ret = await this.useRenderCache(pagePath, cacheKey, async () => {
      return await this.#renderer.renderPage(router, nestedModules)
    })
    return ret[1]
  }

  async getPageHTML(loc: { pathname: string, search?: string }): Promise<[number, string]> {
    const [router, nestedModules] = this.#pageRouting.createRouter(loc)
    const { pagePath } = router
    const status = pagePath !== '' ? 200 : 404

    if (!this.isSSRable(loc.pathname)) {
      const [html] = await this.useRenderCache('-', 'spa-index', async () => {
        return [await this.#renderer.renderSPAIndexPage(), null]
      })
      return [status, html]
    }

    if (pagePath === '') {
      return [status, await this.#renderer.render404Page(router)]
    }

    const cacheKey = router.pathname + router.query.toString()
    const [html] = await this.useRenderCache(pagePath, cacheKey, async () => {
      return await this.#renderer.renderPage(router, nestedModules)
    })
    return [status, html]
  }

  private async useRenderCache(namespace: string, key: string, render: () => Promise<[string, any]>): Promise<[string, any]> {
    let cache = this.#renderCache.get(namespace)
    if (cache === undefined) {
      cache = new Map()
      this.#renderCache.set(namespace, cache)
    }
    const cached = cache.get(key)
    if (cached !== undefined) {
      return cached
    }
    const ret = await render()
    cache.set(key, ret)
    return ret
  }

  /** build the application to a static site(SSG) */
  async build() {
    const start = performance.now()
    const outputDir = this.outputDir
    const distDir = path.join(outputDir, '_aleph')

    // wait for app ready
    await this.ready

    // clear previous build
    if (existsDirSync(outputDir)) {
      for await (const entry of Deno.readDir(outputDir)) {
        await Deno.remove(path.join(outputDir, entry.name), { recursive: entry.isDirectory })
      }
    }
    await ensureDir(distDir)

    //  optimizing
    await this.optimize()
    // ssg
    await this.ssg()
    // copy bundle dist
    await this.#bundler.copyDist()

    // copy public assets
    const publicDir = path.join(this.workingDir, 'public')
    if (existsDirSync(publicDir)) {
      let n = 0
      for await (const { path: p } of walk(publicDir, { includeDirs: false, skip: [/(^|\/)\.DS_Store$/] })) {
        const rp = util.trimPrefix(p, publicDir)
        const fp = path.join(outputDir, rp)
        const fi = await Deno.lstat(p)
        await ensureDir(path.dirname(fp))
        await Deno.copyFile(p, fp)
        if (n === 0) {
          log.info(colors.bold('- Public Assets'))
        }
        log.info('  ∆', rp.split('\\').join('/'), colors.dim('•'), formatBytesWithColor(fi.size))
        n++
      }
    }

    log.info(`Done in ${Math.round(performance.now() - start)}ms`)
  }

  createFSWatcher(): EventEmitter {
    const e = new EventEmitter()
    this.#fsWatchListeners.push(e)
    return e
  }

  removeFSWatcher(e: EventEmitter) {
    e.removeAllListeners()
    const index = this.#fsWatchListeners.indexOf(e)
    if (index > -1) {
      this.#fsWatchListeners.splice(index, 1)
    }
  }

  isHMRable(url: string) {
    if (!this.isDev) {
      return false
    }
    for (const ext of moduleExts) {
      if (url.endsWith('.' + ext)) {
        return (
          url.startsWith('/pages/') ||
          url.startsWith('/components/') ||
          ['/app', '/404'].includes(util.trimSuffix(url, '.' + ext))
        )
      }
    }
    return this.config.plugins.some(p => p.type === 'loader' && p.test.test(url) && (p.allowPage || p.acceptHMR))
  }

  /** inject HMR code  */
  injectHMRCode({ url }: Module, content: string): string {
    const hmrModuleImportUrl = getRelativePath(
      path.dirname(toLocalUrl(url)),
      toLocalUrl(`${getAlephPkgUri()}/framework/core/hmr.js`)
    )
    const lines = [
      `import { createHotContext } from ${JSON.stringify(hmrModuleImportUrl)};`,
      `import.meta.hot = createHotContext(${JSON.stringify(url)});`,
      '',
      content,
      '',
      'import.meta.hot.accept();'
    ]

    let code = lines.join('\n')
    if (this.#injects.hmr.length > 0) {
      this.#injects.hmr.forEach(transform => {
        code = transform(url, code)
      })
    }
    return code
  }

  /** get main code in javascript. */
  getMainJS(bundleMode = false): string {
    const alephPkgUri = getAlephPkgUri()
    const alephPkgPath = alephPkgUri.replace('https://', '').replace('http://localhost:', 'http_localhost_')
    const { baseUrl: baseURL, defaultLocale, framework } = this.config
    const config: Record<string, any> = {
      baseURL,
      defaultLocale,
      locales: [],
      routes: this.#pageRouting.routes,
      rewrites: this.config.rewrites,
      sharedModules: Array.from(this.#modules.values()).filter(({ url }) => {
        switch (trimModuleExt(url)) {
          case '/404':
          case '/app':
            return true
          default:
            return false
        }
      }).map(({ url, hash }) => this.createRouteModule(url, hash)),
      renderMode: this.config.ssr ? 'ssr' : 'spa'
    }

    if (bundleMode) {
      return `var bootstrap=__ALEPH.pack["${alephPkgUri}/framework/${framework}/bootstrap.ts"].default;bootstrap(${JSON.stringify(config)})`
    }

    let code = [
      `import bootstrap from "./-/${alephPkgPath}/framework/${framework}/bootstrap.js";`,
      `bootstrap(${JSON.stringify(config, undefined, this.isDev ? 2 : undefined)});`
    ].filter(Boolean).join('\n')
    if (this.#injects.compilation.length > 0) {
      this.#injects.compilation.forEach(transform => {
        code = transform('/main.js', code)
      })
    }
    return code
  }

  private getDir(name: string, init: () => string) {
    if (this.#dirs.has(name)) {
      return this.#dirs.get(name)!
    }

    const dir = init()
    this.#dirs.set(name, dir)
    return dir
  }

  /** returns the route module by given module. */
  private createRouteModule(url: string, hash: string): RouteModule {
    const useDeno = (this.config.ssr !== false && this.lookupDeps(url).some(dep => dep.url.startsWith('#useDeno-'))) || undefined
    return { url, hash, useDeno }
  }

  /** apply loaders recurively. */
  private async applyLoader(loader: LoaderPlugin, input: { url: string, content: Uint8Array, map?: Uint8Array }): Promise<Omit<LoaderTransformResult, 'loader'>> {
    const { code, map, type } = await loader.transform(input)
    if (type) {
      for (const plugin of this.config.plugins) {
        if (plugin.type === 'loader' && plugin.test.test('.' + type) && plugin !== loader) {
          const encoder = new TextEncoder()
          return this.applyLoader(plugin, {
            url: input.url,
            content: encoder.encode(code),
            map: map ? encoder.encode(map) : undefined
          })
        }
      }
    }
    return { code, map }
  }

  /** default compiler options */
  private get defaultCompileOptions(): TransformOptions {
    return {
      importMap: this.importMap,
      alephPkgUri: getAlephPkgUri(),
      reactVersion: defaultReactVersion,
      isDev: this.isDev,
    }
  }

  /** download and compile a moudle by given url, then cache on the disk. */
  private async compile(
    url: string,
    options: {
      /* use source code string instead of source from IO */
      sourceCode?: string,
      /* drop pervious complation */
      forceCompile?: boolean,
      /* don't record the complation */
      once?: boolean,
    } = {}
  ): Promise<Module> {
    const isRemote = util.isLikelyHttpURL(url)
    const localUrl = toLocalUrl(url)
    const name = trimModuleExt(path.basename(localUrl))
    const saveDir = path.join(this.buildDir, path.dirname(localUrl))
    const metaFile = path.join(saveDir, `${name}.meta.json`)
    const { sourceCode, forceCompile, once } = options

    let mod: Module
    if (this.#modules.has(url)) {
      mod = this.#modules.get(url)!
      if (!forceCompile && !sourceCode) {
        return mod
      }
    } else {
      mod = {
        url,
        deps: [],
        sourceHash: '',
        hash: '',
        jsFile: '',
      }
      if (!once) {
        this.#modules.set(url, mod)
      }
      try {
        if (existsFileSync(metaFile)) {
          const { sourceHash, deps } = JSON.parse(await Deno.readTextFile(metaFile))
          if (util.isNEString(sourceHash) && util.isArray(deps)) {
            mod.sourceHash = sourceHash
            mod.deps = deps
          } else {
            log.warn(`removing invalid metadata '${name}.meta.json'`)
            Deno.remove(metaFile)
          }
        }
      } catch (e) { }
    }

    let sourceContent = new Uint8Array()
    let contentType: null | string = null
    let jsContent = ''
    let jsSourceMap: null | string = null
    let shouldCompile = false
    let fsync = false

    if (sourceCode) {
      sourceContent = (new TextEncoder).encode(sourceCode)
      const sourceHash = computeHash(sourceContent)
      if (mod.sourceHash === '' || mod.sourceHash !== sourceHash) {
        mod.sourceHash = sourceHash
        shouldCompile = true
      }
    } else {
      let shouldFetch = true
      if (
        !this.#reloading &&
        (isRemote && !url.startsWith('http://localhost:')) &&
        reFullVersion.test(url) &&
        mod.sourceHash !== ''
      ) {
        const jsFile = path.join(saveDir, name + '.js')
        if (existsFileSync(jsFile)) {
          shouldFetch = false
        }
      }
      if (shouldFetch) {
        const { content, contentType: ctype } = await this.fetchModule(url)
        const sourceHash = computeHash(content)
        sourceContent = content
        contentType = ctype
        if (mod.sourceHash === '' || mod.sourceHash !== sourceHash) {
          mod.sourceHash = sourceHash
          shouldCompile = true
        }
      }
    }

    mod.hash = computeHash(
      mod.sourceHash +
      JSON.stringify(this.defaultCompileOptions) +
      this.config.plugins.filter(isLoaderPlugin).map(({ name }) => name).join(',')
    )
    if (isRemote) {
      mod.jsFile = util.cleanPath(`${saveDir}/${name}.js`)
    } else {
      mod.jsFile = util.cleanPath(`${saveDir}/${name}.${mod.hash.slice(0, hashShortLength)}.js`)
    }

    // check previous compilation output if the source content doesn't changed.
    if (!shouldCompile && !existsFileSync(mod.jsFile)) {
      shouldCompile = true
    }

    // compile source code
    if (shouldCompile) {
      let sourceCode = (new TextDecoder).decode(sourceContent)
      let sourceType = path.extname(url).slice(1)

      if (sourceType == 'mjs') {
        sourceType = 'js'
      }

      if (isRemote) {
        switch (contentType?.split(';')[0].trim()) {
          case 'application/javascript':
          case 'text/javascript':
            sourceType = 'js'
            break
          case 'text/typescript':
            sourceType = 'ts'
            break
          case 'text/jsx':
            sourceType = 'jsx'
            break
          case 'text/tsx':
            sourceType = 'tsx'
            break
          default:
            sourceType = 'js'
            break
        }
      }

      for (const plugin of this.config.plugins) {
        if (plugin.type === 'loader' && plugin.test.test(url)) {
          const { code, type = 'js' } = await this.applyLoader(
            plugin,
            { url, content: sourceContent }
          )
          sourceCode = code
          sourceType = type
          break
        }
      }

      switch (sourceType) {
        case 'js':
        case 'jsx':
        case 'ts':
        case 'tsx':
          break
        default:
          log.warn(`Unsupported module '${url}'`)
          this.#modules.delete(url)
          return mod
      }

      const t = performance.now()
      const { code, map, deps } = await transform(url, sourceCode, {
        ...this.defaultCompileOptions,
        swcOptions: {
          target: 'es2020',
          sourceType
        },
        sourceMap: this.isDev,
        loaders: this.config.plugins.filter(isLoaderPlugin)
      })

      fsync = true
      jsContent = code
      if (map) {
        jsSourceMap = map
      }

      mod.deps = deps.map(({ specifier, isDynamic }) => {
        const dep: DependencyDescriptor = { url: specifier }
        if (isDynamic) {
          dep.isDynamic = true
        }
        if (dep.url.startsWith('#useDeno-') && !this.config.ssr) {
          log.warn(`use 'useDeno' hook in SPA mode: ${url}`)
        }
        return dep
      })

      log.debug(`compile '${url}' in ${Math.round(performance.now() - t)}ms`)
    }

    // compile deps
    for (const dep of mod.deps.filter(({ url }) => !url.startsWith('#'))) {
      const depMod = await this.compile(dep.url, { once })
      if (!util.isLikelyHttpURL(dep.url)) {
        const relativePathname = getRelativePath(
          path.dirname(toLocalUrl(url)),
          trimModuleExt(toLocalUrl(dep.url))
        )
        if (jsContent === '') {
          jsContent = await Deno.readTextFile(mod.jsFile)
        }
        const newContent = jsContent.replace(reHashResolve, (s, key, spaces, ql, importPath, qr) => {
          const importPathname = importPath.replace(reHashJS, '')
          if (importPathname == dep.url || importPathname === relativePathname) {
            return `${key}${spaces}${ql}${importPathname}.${depMod.hash.slice(0, hashShortLength)}.js${qr}`
          }
          return s
        }
        )
        if (newContent !== jsContent) {
          jsContent = newContent
          if (!fsync) {
            fsync = true
          }
        }
      }
    }

    if (fsync) {
      await clearCompilation(mod.jsFile)
      await Promise.all([
        ensureTextFile(metaFile, JSON.stringify({
          url,
          sourceHash: mod.sourceHash,
          deps: mod.deps,
        }, undefined, 2)),
        ensureTextFile(mod.jsFile, jsContent + (jsSourceMap ? `//# sourceMappingURL=${path.basename(mod.jsFile)}.map` : '')),
        jsSourceMap ? ensureTextFile(mod.jsFile + '.map', jsSourceMap) : Promise.resolve(),
      ])
    }

    return mod
  }

  /** create bundle chunks for production. */
  private async bundle() {
    const entryMods = new Set<string>()
    const depMods = new Map<string, boolean>()
    const refCounter = new Map<string, Set<string>>()
    const addDepEntry = (url: string) => {
      depMods.set(url, true)
      this.lookupDeps(url).forEach(({ url }) => !depMods.has(url) && depMods.set(url, false))
    }
    addDepEntry(`${getAlephPkgUri()}/framework/${this.config.framework}/bootstrap.ts`)
    Array.from(this.#modules.values()).forEach(mod => {
      switch (trimModuleExt(mod.url)) {
        case '/app':
        case '/404':
          addDepEntry(mod.url)
          break
      }
      Array.from(new Set(mod.deps.map(({ url, isDynamic }) => {
        if (isDynamic) {
          entryMods.add(url)
        }
        return url
      }))).filter(url => !url.startsWith('#')).forEach(url => {
        if (refCounter.has(url)) {
          refCounter.get(url)!.add(mod.url)
        } else {
          refCounter.set(url, new Set([mod.url]))
        }
      })
    })
    this.#pageRouting.lookup(routes => {
      routes.forEach(({ module: { url } }) => entryMods.add(url))
    })
    refCounter.forEach((refers, url) => {
      if (refers.size > 1) {
        const localDepEntryMods = Array.from(depMods.entries())
          .filter(([url, isEntry]) => !util.isLikelyHttpURL(url) && isEntry)
          .map(([url]) => url)
        const exported = Array.from(refers)
          .some(url => entryMods.has(url) || localDepEntryMods.includes(url))
        if (exported) {
          addDepEntry(url)
        } else if (!depMods.has(url)) {
          depMods.set(url, false)
        }
      }
    })
    await this.#bundler.bundle(Array.from(entryMods), depMods)
  }

  /** optimize for production. */
  private async optimize() {
    // todo: optimize
  }

  /** render all pages in routing. */
  private async ssg() {
    const { ssr } = this.config
    const outputDir = this.outputDir

    if (ssr === false) {
      const html = await this.#renderer.renderSPAIndexPage()
      await ensureTextFile(path.join(outputDir, 'index.html'), html)
      await ensureTextFile(path.join(outputDir, '404.html'), html)
      return
    }

    log.info(colors.bold('- Pages (SSG)'))
    const paths = new Set(this.#pageRouting.paths)
    if (typeof ssr === 'object' && ssr.staticPaths) {
      ssr.staticPaths.forEach(path => paths.add(path))
    }
    await Promise.all(Array.from(paths).map(async pathname => {
      if (this.isSSRable(pathname)) {
        const [router, nestedModules] = this.#pageRouting.createRouter({ pathname })
        if (router.pagePath !== '') {
          const [html, data] = await this.#renderer.renderPage(router, nestedModules)
          const htmlFile = path.join(outputDir, pathname, 'index.html')
          await ensureTextFile(htmlFile, html)
          if (data) {
            const dataFile = path.join(
              outputDir,
              '_aleph/data',
              (pathname === '/' ? 'index' : pathname) + '.json'
            )
            await ensureTextFile(dataFile, JSON.stringify(data))
          }
          log.info('  ○', pathname, colors.dim('• ' + util.formatBytes(html.length)))
        } else {
          log.error('Page not found:', pathname)
        }
      }
    }))

    // create 404 page
    const [router] = this.#pageRouting.createRouter({ pathname: '/404' })
    await ensureTextFile(
      path.join(outputDir, '404.html'),
      await this.#renderer.render404Page(router)
    )
  }

  /** fetch module content */
  async fetchModule(url: string): Promise<{ content: Uint8Array, contentType: string | null }> {
    if (!util.isLikelyHttpURL(url)) {
      const filepath = path.join(this.srcDir, util.trimPrefix(url, 'file://'))
      const content = await Deno.readFile(filepath)
      return { content, contentType: null }
    }

    const u = new URL(url)
    if (url.startsWith('https://esm.sh/')) {
      if (this.isDev && !u.searchParams.has('dev')) {
        u.searchParams.set('dev', '')
        u.search = u.search.replace('dev=', 'dev')
      }
    }

    const { protocol, hostname, port, pathname, search } = u
    const versioned = reFullVersion.test(pathname)
    const reload = this.#reloading || !versioned
    const isLocalhost = url.startsWith('http://localhost:')
    const cacheDir = path.join(
      this.#dirs.get('denoDir')!,
      'deps',
      util.trimSuffix(protocol, ':'),
      hostname + (port ? '_PORT' + port : '')
    )
    const hash = createHash('sha256').update(pathname + search).toString()
    const contentFile = path.join(cacheDir, hash)
    const metaFile = path.join(cacheDir, hash + '.metadata.json')

    if (!reload && !isLocalhost && existsFileSync(contentFile) && existsFileSync(metaFile)) {
      const [content, meta] = await Promise.all([
        Deno.readFile(contentFile),
        Deno.readTextFile(metaFile),
      ])
      try {
        const { headers } = JSON.parse(meta)
        return {
          content,
          contentType: headers['content-type'] || null
        }
      } catch (e) { }
    }

    // download dep when deno cache failed
    let err = new Error('Unknown')
    for (let i = 0; i < 15; i++) {
      if (i === 0) {
        if (!isLocalhost) {
          log.info('Download', url)
        }
      } else {
        log.debug('Download error:', err)
        log.warn(`Download ${url} failed, retrying...`)
      }
      try {
        const resp = await fetch(u.toString())
        if (resp.status >= 400) {
          return Promise.reject(new Error(resp.statusText))
        }
        const buffer = await resp.arrayBuffer()
        const content = await Deno.readAll(new Deno.Buffer(buffer))
        if (!isLocalhost) {
          await ensureDir(cacheDir)
          Deno.writeFile(contentFile, content)
          Deno.writeTextFile(metaFile, JSON.stringify({
            headers: Array.from(resp.headers.entries()).reduce((m, [k, v]) => {
              m[k] = v
              return m
            }, {} as Record<string, string>),
            url
          }, undefined, 2))
        }
        return {
          content,
          contentType: resp.headers.get('content-type')
        }
      } catch (e) {
        err = e
      }
    }

    return Promise.reject(err)
  }

  /** check compilation side-effect caused by dependency graph changing. */
  private async checkCompilationSideEffect(url: string, callback: (mod: Module) => void) {
    const { hash } = this.#modules.get(url)!

    for (const mod of this.#modules.values()) {
      for (const dep of mod.deps) {
        if (dep.url === url) {
          const relativePathname = getRelativePath(
            path.dirname(toLocalUrl(mod.url)),
            trimModuleExt(toLocalUrl(dep.url))
          )
          const jsContent = (await Deno.readTextFile(mod.jsFile))
            .replace(reHashResolve, (s, key, spaces, ql, importPath, qr) => {
              const importPathname = importPath.replace(reHashJS, '')
              if (importPathname === dep.url || importPathname === relativePathname) {
                return `${key}${spaces}${ql}${importPathname}.${hash.slice(0, hashShortLength)}.js${qr}`
              }
              return s
            })
          await ensureTextFile(mod.jsFile, jsContent)
          callback(mod)
          log.debug('compilation side-effect:', mod.url, colors.dim('<-'), url)
          this.checkCompilationSideEffect(mod.url, callback)
          break
        }
      }
    }
  }

  /** check a page whether is able to SSR. */
  isSSRable(pathname: string): boolean {
    const { ssr } = this.config
    if (util.isPlainObject(ssr)) {
      if (ssr.include) {
        for (let r of ssr.include) {
          if (!r.test(pathname)) {
            return false
          }
        }
      }
      if (ssr.exclude) {
        for (let r of ssr.exclude) {
          if (r.test(pathname)) {
            return false
          }
        }
      }
      return true
    }
    return ssr
  }

  private isScopedModule(url: string) {
    for (const ext of moduleExts) {
      if (url.endsWith('.' + ext)) {
        if (url.startsWith('/pages/') || url.startsWith('/api/')) {
          return true
        }
        switch (trimModuleExt(url)) {
          case '/404':
          case '/app':
            return true
        }
      }
    }

    // is page module by plugin
    if (this.config.plugins.some(p => p.type === 'loader' && p.test.test(url) && p.allowPage)) {
      return true
    }

    // is dep
    for (const { deps } of this.#modules.values()) {
      if (deps.some(dep => dep.url === url)) {
        return true
      }
    }

    return false
  }

  /** lookup deps recurively. */
  private lookupDeps(url: string, __deps: DependencyDescriptor[] = [], __tracing: Set<string> = new Set()) {
    const mod = this.getModule(url)
    if (mod === null) {
      return __deps
    }
    if (__tracing.has(url)) {
      return __deps
    }
    __tracing.add(url)
    __deps.push(...mod.deps.filter(({ url }) => __deps.findIndex(d => d.url === url) === -1))
    mod.deps.forEach(({ url }) => this.lookupDeps(url, __deps, __tracing))
    return __deps
  }
}
