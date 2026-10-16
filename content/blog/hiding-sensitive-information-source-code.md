---
title: Hiding sensitive information source code
date: 2024-11-11
description: Ways to keep sensitive information out of source code.
tags: [tech]
---

A k8s Secret is an object that stores a small amount of sensitive data, which goes into your Deployment or Pod spec instead of your source code. Secrets are created and deployed independently of the Pods that use them, so there is less risk of exposing them.

## Use Secret as environment variables

First, create your Secret like this. Note that:

* Secrets are namespace scoped, so you cannot share them between namespaces.

* The values must be base64 encoded in the manifest, but your app receives the original value.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
  namespace: app-namespace
type: Opaque
data:
  redis-connection-string: <your value as a base64 value>
```

Then reference it in your Deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: your-app
spec:
  template:
    spec:
      containers:
      - name: your-app
        env:
        - name: ConnectionStrings__Redis
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: redis-connection-string
```

Then by calling

```csharp
var builder = WebApplication.CreateBuilder(args);   
builder.Configuration
    .AddEnvironmentVariables();
```

you get the same result as having

```json
{
  "ConnectionStrings": {
    "Redis": "<your value>"
  }
}
```

in your configuration.

Because Secrets are namespace scoped, you can use one to store secrets shared by the microservices in that namespace, like your Redis password, Kafka credentials, third party accounts, etc.

## Mount the Secret as volume

You can also mount the Secret as a volume:

```yaml
kind: Deployment
metadata:
  name: your-app
spec:
  template:
    spec:
      containers:
      - name: your-app
        volumeMounts:
        - name: secrets
          mountPath: /etc/secrets
          readOnly: true
      volumes:
      - name: secrets
        secret:
          secretName: app-secrets
```

and load every key value pair from that directory into your configuration with

```csharp
builder.Configuration
    .AddKeyPerFile("/etc/secrets", optional: true);
```

Cons:

* More complicated

* It's written to the file system, so the attack surface is bigger than keeping it in memory

* Slower startup, since the app reads from the mounted volume

Good when:

* Your secret is actually a file like a cert or configuration file (e.g. cloud provider credentials)

* You need to handle a large number of environment variables

## Mount the secret FILE as volume

You can move the sensitive part of your configuration into a Secret, mount it as a volume, and merge it with the non sensitive part on startup.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: app-settings
type: Opaque
data:
  appsettings.Secrets.Production.json: |
    {
      "RedisConfiguration": {
        "Enable": true,
        "ConnectionString": <some string>
      }
    }
```

Then merge them:

```csharp
builder.Configuration
    .AddJsonFile("appsettings.json", true)
    .AddJsonFile($"appsettings.{builder.Environment.EnvironmentName}.json", true)
    .AddJsonFile($"/etc/secrets/appsettings.Secrets.{builder.Environment.EnvironmentName}.json", true);
```

This is the most complicated option, but it works well when your configuration file is complicated.

## What about secrets locally

Ideally you don't need any secrets for local development, but sometimes you can't avoid it. There are 2 main ways to keep them out of the repo:

1. Use `user-secrets`. The ASP.NET Core documentation on safe local secret storage covers how it works.

2. Don't check in `appsettings.Development.json`, and make sure `appsettings.json` has every key that `appsettings.Development.json` has.

Either way, make sure your team knows how the project is set up.

## What about secrets in the pipeline

If your pipeline needs a secret (for integration or end to end tests) and has no access to k8s Secrets, use your CI/CD tool to inject the secret or the file:

1. CI/CD variables: in the before script, use `sed` and `cat` to inject the values or create the file in the repository

2. Secure files: if you need a whole file in the pipeline, use your CI/CD platform's secure files feature.

```yaml
test:
  stage: test
  tags:
    - docker
  image: mcr.microsoft.com/dotnet/sdk:8.0
  variables:
    SECURE_FILES_DOWNLOAD_PATH: './MyProject/'
  script:
    - curl --silent "https://ci.example.com/secure_files/installer" | bash
    - dotnet test MyProject.IntegrationTests
```

## What is the difference between ConfigMap and Secret

The difference is mostly intent. Their creator explains it here: https://stackoverflow.com/a/36925553
