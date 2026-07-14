<script setup lang="ts">
useHead({ title: "about me" });
</script>

<template>
  <main class="about">
    <header class="page-header">
      <h1>About</h1>
    </header>

    <p class="about-lede">Hi, I'm Long.</p>

    <section class="prose">
      <p>
        This is a public notebook for technical concepts, reading notes, reference material and occassionally random things.
      </p>
      <p>
        I build software primarily in C#/.NET with SQL, but I also am very familiar with Vue, Python, Go, and infrastructure like Docker and Kubernetes. I read broadly across the field; I'm a generalist by nature.
      </p>
      <p>
        For work inquiries (or some quiet disagreement), reach me via
        <a href="mailto:hlong.mseh@gmail.com">email</a> or
        <a href="https://t.me/hailong1" target="_blank" rel="noopener">telegram</a>.
      </p>
      <hr />

      <dl class="elsewhere">
        <dt>github</dt>
        <dd>
          <a href="https://github.com/haiilong" target="_blank" rel="noopener">github.com/haiilong</a>
        </dd>

        <dt>résumé</dt>
        <dd>
          <a href="/vuhailong_resume.pdf" target="_blank" rel="noopener">PDF</a>
        </dd>
      </dl>
    </section>
  </main>
</template>
