<script setup lang="ts">
const route = useRoute();
const slug = Array.isArray(route.params.slug) ? route.params.slug : [route.params.slug];
const path = `/blog/${slug.join("/")}`;

const { data: post } = await useAsyncData(`post-${path}`, () =>
  queryCollection("blog").path(path).first(),
);

if (!post.value) {
  throw createError({
    statusCode: 404,
    statusMessage: "Post not found",
    fatal: true,
  });
}

useHead({ title: `${post.value.title} — long` });

const formatDate = (date: string) => {
  const d = new Date(date);
  return d
    .toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })
    .toLowerCase();
};
</script>

<template>
  <article v-if="post" class="post">
    <nav class="post-nav">
      <NuxtLink to="/">← back to the notebook</NuxtLink>
    </nav>

    <header class="post-header">
      <h1>{{ post.title }}</h1>
      <div class="post-meta">
        <time :datetime="post.date">{{ formatDate(post.date) }}</time>
        <template v-if="post.tags && (post.tags as string[]).length">
          <span class="sep">·</span>
          <ul class="post-tags">
            <li v-for="tag in (post.tags as string[])" :key="tag" :data-tag="tag">
              {{ tag }}
            </li>
          </ul>
        </template>
      </div>
    </header>

    <ContentRenderer :value="post" class="prose" />
  </article>
</template>
