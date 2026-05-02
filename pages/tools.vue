<script setup lang="ts">
useHead({ title: "tools" });

type Tool = {
  name: string;
  url: string;
  domain: string;
  description: string;
};

const tools: Tool[] = [
  {
    name: "curve-solver",
    url: "https://haiilong.github.io/curve-solver",
    domain: "haiilong.github.io/curve-solver",
    description:
      "Built for Desmos. Given a list of points, it solves them exactly (linear, quadratic, cubic, circle for 3 points, general conic for 5) or approximates them (sine, log, exponential, or axis-aligned ellipse). Copy-paste helpers move points and equations straight between the page and Desmos.",
  },
  {
    name: "calculus-walkthrough",
    url: "https://haiilong.github.io/calculus-walkthrough/",
    domain: "haiilong.github.io/calculus-walkthrough",
    description:
      "O/A level calculus solver. Each step shows the rule that was applied and the expression before and after it.",
  },
];
</script>

<template>
  <main>
    <header class="page-header">
      <h1>Tools</h1>
      <p class="lede">Small things I've made and put online.</p>
    </header>

    <ol class="post-list">
      <li v-for="tool in tools" :key="tool.url" class="post-list-item">
        <div class="post-list-entry">
          <div class="post-list-heading">
            <a :href="tool.url" target="_blank" rel="noopener" class="post-link">
              {{ tool.name }}
            </a>
          </div>
          <a :href="tool.url" target="_blank" rel="noopener" class="tool-domain">
            {{ tool.domain }} ↗
          </a>
          <p class="tool-desc">{{ tool.description }}</p>
        </div>
      </li>
    </ol>
  </main>
</template>
