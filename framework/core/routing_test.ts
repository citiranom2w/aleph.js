import { assertEquals } from 'https://deno.land/std@0.90.0/testing/asserts.ts'
import { Routing } from './routing.ts'

Deno.test(`routing`, () => {
  const routing = new Routing({
    locales: ['en', 'zh-CN'],
    rewrites: {
      '/Hello World': '/hello-world',
      '/你好世界': '/zh-CN/hello-world',
    }
  })

  routing.update(
    '/',
    '/pages/index.tsx'
  )
  routing.update(
    '/hello-world',
    '/pages/hello-world.tsx'
  )
  routing.update(
    '/blog',
    '/pages/blog/index.tsx',
    { isIndexModule: true }
  )
  routing.update(
    '/blog/[slug]',
    '/pages/blog/[slug].tsx'
  )
  routing.update(
    '/user',
    '/pages/user/index.tsx',
    { isIndexModule: true }
  )
  routing.update(
    '/user/[...all]',
    '/pages/user/[...all].tsx'
  )
  routing.update(
    '/blog',
    '/pages/blog.tsx'
  )
  routing.update(
    '/user',
    '/pages/user.tsx'
  )
  routing.update(
    '/blog/[slug]/subpage',
    '/pages/blog/[slug]/subpage.tsx'
  )
  routing.update(
    '/docs',
    '/pages/docs.tsx'
  )
  routing.update(
    '/docs/get-started',
    '/pages/docs/get-started.tsx'
  )
  routing.update(
    '/docs/installation',
    '/pages/docs/installation.tsx'
  )
  routing.update(
    '/',
    '/pages/index.tsx',
    { isIndexModule: true }
  )

  assertEquals(routing.paths, [
    '/',
    '/hello-world',
    '/blog',
    '/user',
    '/docs',
    '/blog/[slug]',
    '/blog/[slug]/subpage',
    '/user/[...all]',
    '/docs/get-started',
    '/docs/installation',
  ])

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/' })
    assertEquals(router.locale, 'en')
    assertEquals(router.pathname, '/')
    assertEquals(router.pagePath, '/')
    assertEquals(nestedModules.map(m => m.url), ['/pages/index.tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/zh-CN' })
    assertEquals(router.locale, 'zh-CN')
    assertEquals(router.pathname, '/')
    assertEquals(router.pagePath, '/')
    assertEquals(nestedModules.map(m => m.url), ['/pages/index.tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/Hello World' })
    assertEquals(router.locale, 'en')
    assertEquals(router.pathname, '/hello-world')
    assertEquals(router.pagePath, '/hello-world')
    assertEquals(nestedModules.map(m => m.url), ['/pages/hello-world.tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/你好世界' })
    assertEquals(router.locale, 'zh-CN')
    assertEquals(router.pathname, '/hello-world')
    assertEquals(router.pagePath, '/hello-world')
    assertEquals(nestedModules.map(m => m.url), ['/pages/hello-world.tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/blog' })
    assertEquals(router.locale, 'en')
    assertEquals(router.pathname, '/blog')
    assertEquals(router.pagePath, '/blog')
    assertEquals(nestedModules.map(m => m.url), ['/pages/blog.tsx', '/pages/blog/index.tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/zh-CN/blog' })
    assertEquals(router.locale, 'zh-CN')
    assertEquals(router.pathname, '/blog')
    assertEquals(router.pagePath, '/blog')
    assertEquals(nestedModules.map(m => m.url), ['/pages/blog.tsx', '/pages/blog/index.tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/blog/hello-world' })
    assertEquals(router.pathname, '/blog/hello-world')
    assertEquals(router.pagePath, '/blog/[slug]')
    assertEquals(router.params, { slug: 'hello-world' })
    assertEquals(nestedModules.map(m => m.url), ['/pages/blog.tsx', '/pages/blog/[slug].tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/user' })
    assertEquals(router.pathname, '/user')
    assertEquals(router.pagePath, '/user')
    assertEquals(router.params, {})
    assertEquals(nestedModules.map(m => m.url), ['/pages/user.tsx', '/pages/user/index.tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/user/projects' })
    assertEquals(router.pathname, '/user/projects')
    assertEquals(router.pagePath, '/user/[...all]')
    assertEquals(router.params, { all: 'projects' })
    assertEquals(nestedModules.map(m => m.url), ['/pages/user.tsx', '/pages/user/[...all].tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/user/settings/profile' })
    assertEquals(router.pathname, '/user/settings/profile')
    assertEquals(router.pagePath, '/user/[...all]')
    assertEquals(router.params, { all: 'settings/profile' })
    assertEquals(nestedModules.map(m => m.url), ['/pages/user.tsx', '/pages/user/[...all].tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/user/settings/security' })
    assertEquals(router.pathname, '/user/settings/security')
    assertEquals(router.pagePath, '/user/[...all]')
    assertEquals(router.params, { all: 'settings/security' })
    assertEquals(nestedModules.map(m => m.url), ['/pages/user.tsx', '/pages/user/[...all].tsx'])
  }

  {
    const [router, nestedModules] = routing.createRouter({ pathname: '/null' })
    assertEquals(router.pathname, '/null')
    assertEquals(router.pagePath, '')
    assertEquals(router.params, {})
    assertEquals(nestedModules.map(m => m.url), [])
  }
})
