import type { AcceptedPlugin } from '../deps.ts'
import { path } from '../deps.ts'
import { defaultReactVersion } from '../shared/constants.ts'
import { existsFileSync } from '../shared/fs.ts'
import log from '../shared/log.ts'
import util from '../shared/util.ts'
import type { Config, ImportMap } from '../types.ts'
import { VERSION } from '../version.ts'
import { fixImportMap, reLocaleID } from './util.ts'

export const defaultConfig: Readonly<Required<Config>> = {
  framework: 'react',
  reactVersion: defaultReactVersion,
  buildTarget: 'es5',
  baseUrl: '/',
  srcDir: '/',
  outputDir: '/dist',
  defaultLocale: 'en',
  locales: [],
  rewrites: {},
  ssr: {},
  plugins: [],
  postcss: {
    plugins: [
      'autoprefixer'
    ]
  },
  env: {},
}


/** load config from `aleph.config.(ts|js|json)` */
export async function loadConfig(workingDir: string): Promise<[Config, ImportMap]> {
  let data: Config = {}
  for (const name of Array.from(['ts', 'js', 'json']).map(ext => 'aleph.config.' + ext)) {
    const p = path.join(workingDir, name)
    if (existsFileSync(p)) {
      log.info('Aleph server config loaded from', name)
      if (name.endsWith('.json')) {
        const v = JSON.parse(await Deno.readTextFile(p))
        if (util.isPlainObject(v)) {
          data = v
        }
      } else {
        let { default: v } = await import('file://' + p)
        if (util.isFunction(v)) {
          v = await v()
        }
        if (util.isPlainObject(v)) {
          data = v
        }
      }
      break
    }
  }

  const config: Config = {}
  const {
    framework,
    reactVersion,
    srcDir,
    outputDir,
    baseUrl,
    buildTarget,
    defaultLocale,
    locales,
    ssr,
    rewrites,
    plugins,
    postcss,
    env,
  } = data
  if (isFramework(framework)) {
    config.framework = framework
  }
  if (util.isNEString(reactVersion)) {
    config.reactVersion = reactVersion
  }
  if (util.isNEString(srcDir)) {
    config.srcDir = util.cleanPath(srcDir)
  }
  if (util.isNEString(outputDir)) {
    config.outputDir = util.cleanPath(outputDir)
  }
  if (util.isNEString(baseUrl)) {
    config.baseUrl = util.cleanPath(encodeURI(baseUrl))
  }
  if (isTarget(buildTarget)) {
    config.buildTarget = buildTarget
  }
  if (util.isNEString(defaultLocale)) {
    config.defaultLocale = defaultLocale
  }
  if (util.isArray(locales)) {
    locales.filter(l => !reLocaleID.test(l)).forEach(l => log.warn(`invalid locale ID '${l}'`))
    config.locales = Array.from(new Set(locales.filter(l => reLocaleID.test(l))))
  }
  if (typeof ssr === 'boolean') {
    config.ssr = ssr
  } else if (util.isPlainObject(ssr)) {
    const include = util.isArray(ssr.include) ? ssr.include.map(v => util.isNEString(v) ? new RegExp(v) : v).filter(v => v instanceof RegExp) : []
    const exclude = util.isArray(ssr.exclude) ? ssr.exclude.map(v => util.isNEString(v) ? new RegExp(v) : v).filter(v => v instanceof RegExp) : []
    const staticPaths = util.isArray(ssr.staticPaths) ? ssr.staticPaths.map(v => util.cleanPath(v.split('?')[0])) : []
    config.ssr = { include, exclude, staticPaths }
  }
  if (util.isPlainObject(rewrites)) {
    config.rewrites = rewrites
  }
  if (util.isPlainObject(env)) {
    config.env = env
  }
  if (util.isNEArray(plugins)) {
    config.plugins = plugins
  }
  if (isPostcssConfig(postcss)) {
    config.postcss = postcss
  } else {
    for (const name of Array.from(['ts', 'js', 'json']).map(ext => `postcss.config.${ext}`)) {
      const p = path.join(workingDir, name)
      if (existsFileSync(p)) {
        if (name.endsWith('.json')) {
          const postcss = JSON.parse(await Deno.readTextFile(p))
          if (isPostcssConfig(postcss)) {
            config.postcss = postcss
          }
        } else {
          let { default: postcss } = await import('file://' + p)
          if (util.isFunction(postcss)) {
            postcss = await postcss()
          }
          if (isPostcssConfig(postcss)) {
            config.postcss = postcss
          }
        }
        break
      }
    }
  }

  // todo: load ssr.config.ts

  // load import maps
  const importMap: ImportMap = { imports: {}, scopes: {} }
  for (const filename of Array.from(['import_map', 'import-map', 'importmap']).map(name => `${name}.json`)) {
    const importMapFile = path.join(workingDir, filename)
    if (existsFileSync(importMapFile)) {
      const importMap = JSON.parse(await Deno.readTextFile(importMapFile))
      const imports: Record<string, string> = fixImportMap(importMap.imports)
      const scopes: Record<string, Record<string, string>> = {}
      if (util.isPlainObject(importMap.scopes)) {
        Object.entries(importMap.scopes).forEach(([key, imports]) => {
          scopes[key] = fixImportMap(imports)
        })
      }
      Object.assign(importMap, { imports, scopes })
      break
    }
  }

  // update import map for alephjs dev env
  const { __ALEPH_DEV_PORT: devPort } = globalThis as any
  if (devPort) {
    const alias = `http://localhost:${devPort}/`
    const imports = {
      'https://deno.land/x/aleph/': alias,
      [`https://deno.land/x/aleph@v${VERSION}/`]: alias,
      'aleph': `${alias}mod.ts`,
      'aleph/': alias,
      'react': `https://esm.sh/react@${config.reactVersion}`,
      'react-dom': `https://esm.sh/react-dom@${config.reactVersion}`,
    }
    Object.assign(importMap.imports, imports)
  }

  return [config, importMap]
}

function isFramework(v: any): v is 'react' {
  switch (v) {
    case 'react':
      return true
    default:
      return false
  }
}

function isTarget(v: any): v is 'es5' | 'es2015' | 'es2016' | 'es2017' | 'es2018' | 'es2019' | 'es2020' {
  switch (v) {
    case 'es5':
    case 'es2015':
    case 'es2016':
    case 'es2017':
    case 'es2018':
    case 'es2019':
    case 'es2020':
      return true
    default:
      return false
  }
}

function isPostcssConfig(v: any): v is { plugins: (string | AcceptedPlugin | [string | ((options: Record<string, any>) => AcceptedPlugin), Record<string, any>])[] } {
  return util.isPlainObject(v) && util.isArray(v.plugins)
}
