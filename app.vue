<script setup lang="ts">
const { theme, toggle, syncFromDom } = useTheme();
onMounted(syncFromDom);
</script>

<template>
  <div class="site">
    <nav class="site-nav">
      <NuxtLink to="/" class="site-brand">
        <span>long</span>
      </NuxtLink>
      <div class="site-nav-links">
        <NuxtLink to="/">writing</NuxtLink>
        <NuxtLink to="/about">about</NuxtLink>
        <button
          class="theme-toggle"
          type="button"
          :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
          :title="theme === 'dark' ? 'light mode' : 'dark mode'"
          @click="toggle"
        >
          <span aria-hidden="true">{{ theme === "dark" ? "☀" : "☾" }}</span>
        </button>
      </div>
    </nav>

    <NuxtPage />
  </div>
</template>
