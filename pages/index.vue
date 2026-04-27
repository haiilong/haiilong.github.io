<script setup lang="ts">
const { data: posts } = await useAsyncData("blog-list", () =>
  queryCollection("blog").order("date", "DESC").all(),
);

const selectedTag = ref<string | null>(null);
const currentPage = ref(1);
const PAGE_SIZE = 10;

const allTags = computed(() => {
  const counts = new Map<string, number>();
  posts.value?.forEach((p) => {
    (p.tags as string[] | undefined)?.forEach((t) => {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
});

const filteredPosts = computed(() => {
  if (!posts.value) return [];
  if (!selectedTag.value) return posts.value;
  return posts.value.filter((p) => (p.tags as string[] | undefined)?.includes(selectedTag.value!));
});

const totalPages = computed(() =>
  Math.max(1, Math.ceil(filteredPosts.value.length / PAGE_SIZE)),
);

const paginatedPosts = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE;
  return filteredPosts.value.slice(start, start + PAGE_SIZE);
});

// Reset to page 1 whenever the tag filter changes
watch(selectedTag, () => {
  currentPage.value = 1;
});

// Clamp the current page if filtering ever leaves us past the new last page
watch(totalPages, (n) => {
  if (currentPage.value > n) currentPage.value = n;
});

const goToPage = (n: number) => {
  if (n < 1 || n > totalPages.value) return;
  currentPage.value = n;
  if (import.meta.client) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
};

const formatDate = (date: string) => {
  const d = new Date(date);
  return d
    .toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    })
    .toLowerCase();
};
</script>

<template>
  <main>
    <header class="page-header">
      <h1>Writing</h1>
    </header>

    <div v-if="allTags.length" class="tag-filter" role="tablist" aria-label="Filter posts by tag">
      <button
        class="tag-chip"
        :class="{ active: selectedTag === null }"
        type="button"
        role="tab"
        :aria-selected="selectedTag === null"
        @click="selectedTag = null"
      >
        all
      </button>
      <button
        v-for="t in allTags"
        :key="t"
        class="tag-chip"
        :class="{ active: selectedTag === t }"
        :data-tag="t"
        type="button"
        role="tab"
        :aria-selected="selectedTag === t"
        @click="selectedTag = t"
      >
        {{ t }}
      </button>
    </div>

    <ol v-if="paginatedPosts.length" class="post-list">
      <li v-for="post in paginatedPosts" :key="post.path" class="post-list-item">
        <div class="post-list-entry">
          <div class="post-list-heading">
            <NuxtLink :to="post.path" class="post-link">{{ post.title }}</NuxtLink>
            <ul v-if="post.tags && (post.tags as string[]).length" class="post-list-tags">
              <li v-for="t in post.tags as string[]" :key="t" :data-tag="t">
                {{ t }}
              </li>
            </ul>
          </div>
          <time :datetime="post.date" class="post-date">{{ formatDate(post.date) }}</time>
          <p v-if="post.description" class="post-desc">
            {{ post.description }}
          </p>
        </div>
      </li>
    </ol>

    <p v-else class="lede">
      Nothing here under <em>{{ selectedTag }}</em> yet.
    </p>

    <nav v-if="totalPages > 1" class="pagination" aria-label="Pagination">
      <button
        type="button"
        class="pagination-step"
        :disabled="currentPage === 1"
        @click="goToPage(currentPage - 1)"
      >
        ← prev
      </button>
      <span class="pagination-indicator">
        page {{ currentPage }} <span class="sep">/</span> {{ totalPages }}
      </span>
      <button
        type="button"
        class="pagination-step"
        :disabled="currentPage === totalPages"
        @click="goToPage(currentPage + 1)"
      >
        next →
      </button>
    </nav>
  </main>
</template>
