export interface AlephRuntime {
    env: Record<string, string>
    __version: string
    __appRoot: string
    __buildMode: string
    __buildTarget: string
}

export interface SSROptions {
    readonly fallback?: string // default is '_fallback.html'
    readonly include?: RegExp[]
    readonly exclude?: RegExp[]
    readonly staticPaths?: string[]
}

export interface Config {
    readonly srcDir: string
    readonly outputDir: string
    readonly baseUrl: string
    readonly defaultLocale: string
    readonly locales: string[]
    readonly ssr: boolean | SSROptions
    readonly buildTarget: string
    readonly sourceMap: boolean
    readonly env: Record<string, string>
    readonly importMap: {
        imports: Record<string, string>
    }
}

export interface APIRequestURL {
    readonly proto: string
    readonly protoMinor: number
    readonly protoMajor: number
    readonly pathname: string
    readonly params: ReadonlyMap<string, string>
    readonly query: URLSearchParams
}

export interface APIRequest {
    readonly method: string
    readonly url: APIRequestURL
    readonly headers: Headers
    readonly cookies: ReadonlyMap<string, string>
}

export interface APIResponse {
    status(code: number): this
    addHeader(key: string, value: string): this
    setHeader(key: string, value: string): this
    removeHeader(key: string): this
    send(data: string | Uint8Array | ArrayBuffer): Promise<void>
    json(data: any): Promise<void>
}

export interface APIHandle {
    (req: APIRequest, res: APIResponse): void
}

export interface RouterURL {
    readonly locale: string
    readonly pathname: string
    readonly pagePath: string
    readonly params: Record<string, string>
    readonly query: URLSearchParams
}
