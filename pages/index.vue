<script setup lang="ts">
const { data: posts } = await useAsyncData('blog-list', () =>
  queryCollection('blog')
    .order('date', 'DESC')
    .all()
)

const formatDate = (date: string) => {
  const d = new Date(date)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' })
}
</script>

<template>
  <main class="page">
    <header class="page-header">
      <h1>writing</h1>
      <p class="muted">notes on tech, life, and the random</p>
    </header>

    <ul v-if="posts && posts.length" class="post-list">
      <li v-for="post in posts" :key="post.path" class="post-list-item">
        <time :datetime="post.date" class="muted mono">{{ formatDate(post.date) }}</time>
        <NuxtLink :to="post.path" class="post-link">{{ post.title }}</NuxtLink>
      </li>
    </ul>
    <p v-else class="muted">No posts yet.</p>
  </main>
</template>
