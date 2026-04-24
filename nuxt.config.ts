export default defineNuxtConfig({
  modules: ["@nuxt/content"],
  css: ["~/assets/css/main.css"],
  app: {
    head: {
      htmlAttrs: { lang: "en" },
      title: "long",
      meta: [
        { charset: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        {
          name: "description",
          content: "A quiet notebook on tech, life, and the random.",
        },
        { name: "color-scheme", content: "light dark" },
      ],
      link: [
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        {
          rel: "preconnect",
          href: "https://fonts.gstatic.com",
          crossorigin: "",
        },
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Averia+Serif+Libre:wght@700&family=Vollkorn:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap",
        },
      ],
      script: [
        {
          tagPosition: "head",
          innerHTML:
            "(function(){try{if(localStorage.getItem('theme')==='dark')document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();",
        },
      ],
    },
  },
  content: {
    build: {
      markdown: {
        highlight: {
          theme: {
            default: "one-light",
            dark: "one-dark-pro",
          },
        },
      },
    },
  },
  nitro: {
    prerender: {
      crawlLinks: true,
      routes: ["/"],
    },
  },
  compatibilityDate: "2025-04-01",
});
