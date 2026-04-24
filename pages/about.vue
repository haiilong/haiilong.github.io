<script setup lang="ts">
useHead({ title: "about me" });
</script>

<template>
  <main class="about">
    <header class="page-header">
      <h1>About</h1>
    </header>

    <p class="about-lede">Hi, I'm Long (some people call me Hai Long).</p>

    <section class="prose">
      <p>
        This is where I keep notes I'd rather not lose, sometimes technical, sometimes not. It also
        doubles as a home for static things that need somewhere to sit.
      </p>
      <p>
        I work on software. Day to day that's mostly C# and .NET, with regular detours through Vue,
        Python, Go, SQL Server, MongoDB, Docker, and Kubernetes. Outside of that I read widely across the
        rest of the field, more generalist than specialist.
      </p>
      <p>
        If you want to reach me about work, a book recommendation, or a quiet disagreement,
        <a href="mailto:hlong.mseh@gmail.com">email</a> or
        <a href="https://t.me/hailong1" target="_blank" rel="noopener">telegram</a> are the best
        channels.
      </p>
      <hr />

      <dl class="elsewhere">
        <dt>github</dt>
        <dd>
          <a href="https://github.com/haiilong" target="_blank" rel="noopener">github.com/haiilong</a>
        </dd>

        <dt>résumé</dt>
        <dd>
          <a href="/resume.pdf" target="_blank" rel="noopener">PDF</a>
        </dd>
      </dl>
    </section>
  </main>
</template>
