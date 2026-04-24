<script setup lang="ts">
const route = useRoute()
const slug = Array.isArray(route.params.slug) ? route.params.slug : [route.params.slug]
const path = `/blog/${slug.join('/')}`

const { data: post } = await useAsyncData(`post-${path}`, () =>
  queryCollection('blog').path(path).first()
)

if (!post.value) {
  throw createError({ statusCode: 404, statusMessage: 'Post not found', fatal: true })
}

useHead({ title: post.value.title })

const formatDate = (date: string) => {
  const d = new Date(date)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}
</script>

<template>
  <article v-if="post" class="post">
    <header class="post-header">
      <NuxtLink to="/" class="back-link">← writing</NuxtLink>
      <h1>{{ post.title }}</h1>
      <time :datetime="post.date" class="muted mono">{{ formatDate(post.date) }}</time>
    </header>
    <ContentRenderer :value="post" class="prose" />
  </article>
</template>
