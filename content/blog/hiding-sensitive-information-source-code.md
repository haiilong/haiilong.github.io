---
title: Hiding sensitive information source code
date: 2024-11-11
description: Ways to keep sensitive information out of source code.
tags: [tech]
---

A k8s Secret is a small an object that stores a small sensitive amount of data, that will be put into your Deployment or Pod specification instead of your source code. Because Secret can be created and deployed separately and independently of the Pod that uses them, there is less risk of exposure.

## Use Secret as environment variables

First you can create your Secret like this. Note that:

* Secret is namespace scope, you cannot share between namespaces.

* Value of the secret must be base64 encoded, even though the original value will be stored.

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

After that you can use this variable in your Deployment

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

And by calling

```csharp
var builder = WebApplication.CreateBuilder(args);   
builder.Configuration
    .AddEnvironmentVariables();
```

you will have the same effect of

```json
{
  "ConnectionStrings": {
    "Redis": "<your value>"
  }
}
```

in your configuration.

Note that:

* Since Secrets are namespace specific, you can use it to store common secret data across your apps like your Redis password, Kafka credentials, third party accounts, etc. that are shared between your microservices

## Mount the Secret as volume

You can also mount the secret as a Persistent Volume

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

and add every key value pairs from that directory to your code by calling

```csharp
builder.Configuration
    .AddKeyPerFile("/etc/secrets", optional: true);
```

Cons:

* More complicated

* Written to file system so there is higher attack surface compared to in memory

* Slower startup time to read from mounted volume

Pros:

* When your secret is actually a file like a cert or configuration file (e.g. cloud provider credentials)

* When you need to handle a large numbers of environment variables

## Mount the secret FILE as volume

You can move the data sensitive part of your configuration and mount it as a volume. And you can merge that configuration with the non sensitive part on startup.

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

Then you can merge them together

```csharp
builder.Configuration
    .AddJsonFile("appsettings.json", true)
    .AddJsonFile($"appsettings.{builder.Environment.EnvironmentName}.json", true)
    .AddJsonFile($"/etc/secrets/appsettings.Secrets.{builder.Environment.EnvironmentName}.json", true);
```

This is the most complicated but good when you have complicated configuration file

## How about Secret locally

The best practice is to not have any secrets in your local development, but sometimes, you cannot avoid that. There are 2 main ways to avoid this:

1. You can use `user-secrets`. For more information, you can check out the ASP.NET Core documentation for safe local secret storage.

2. You don't check in `appsettings.Development.json`. Make sure `appsettings.json` has every key `appsettings.json` has.

In both case, your team should know about the setup for this project code base.

## How about Secret in pipeline

If you need some kind of Secret in pipeline (Integration or end to end testings) and have no access to k8s Secrets, you need to use the CI/CD tools to inject the Secret or the file:

1. Using CI/CD variables: use `sed` and `cat` to inject or create the file and add in repository before script

2. Using secured files: if you need to add an entire file in the pipeline, use the secured file feature from your CI/CD platform.

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

The difference is mainly the intention. You can check out the answer from the creator of them here: https://stackoverflow.com/a/36925553
