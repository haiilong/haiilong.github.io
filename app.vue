<template>
  <div class="site">
    <nav class="site-nav">
      <NuxtLink to="/" class="site-brand">long</NuxtLink>
      <div class="site-nav-links">
        <NuxtLink to="/">writing</NuxtLink>
        <NuxtLink to="/about">about</NuxtLink>
      </div>
    </nav>

    <NuxtPage />

    <footer class="site-footer">
      <p>© {{ new Date().getFullYear() }} long</p>
    </footer>
  </div>
</template>
