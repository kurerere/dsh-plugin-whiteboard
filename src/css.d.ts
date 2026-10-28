/** The build script loads plain `.css` files as text (the plugin injects them itself). */
declare module '*.css' {
  const text: string
  export default text
}
