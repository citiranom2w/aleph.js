export const KB = 1024
export const MB = KB ** 2
export const GB = KB ** 3
export const TB = KB ** 4
export const PB = KB ** 5
export const hashShort = 9
export const reHttp = /^https?:\/\//i
export const reModuleExt = /\.(js|jsx|mjs|ts|tsx)$/i
export const reStyleModuleExt = /\.(css|less)$/i
export const reMDExt = /\.(md|markdown)$/i
export const reLocaleID = /^[a-z]{2}(-[a-zA-Z0-9]+)?$/
export const reFullVersion = /@v?\d+\.\d+\.\d+/i
export const reHashJs = new RegExp(`\\.[0-9a-fx]{${hashShort}}\\.js$`, 'i')
export const reHashResolve = new RegExp(`(import|import\\s*\\(|from|href\\s*:)(\\s*)("|')([^'"]+.[0-9a-fx]{${hashShort}}\\.js)("|')`, 'g')
