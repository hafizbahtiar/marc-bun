// Modul teks: wrangler (peraturan Text lalai untuk **/*.txt) dan Bun (loader
// text) kedua-duanya mengimport fail .txt sebagai string.
declare module '*.txt' {
  const content: string
  export default content
}
