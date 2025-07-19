---
title: 'Writing Helm Values With Gemini'
date: '2025-07-19'
tags: ['kubernetes', 'heml', 'Gemini']
images: ['/static/images/thumbnail/writing-helm-values-with-gemini.png']
summary: 'I often write values.yaml files to install open-source projects on Kubernetes clusters. This time, I needed to add tolerations to ensure all components of Sentry would run on specific nodes. Since Sentry has quite a few components, I decided to leverage Gemini to generate the values.yaml file more quickly.'
---

## Installing Sentry With Helm Chart

Sentry provides a self-hosting option under a license that allows free usage, as long as you’re not selling a product that includes Sentry. They offer a script and a Docker Compose file that make it easy to install all necessary components on your server.

If you want to run self-hosted Sentry on a Kubernetes cluster, you can use the [Sentry Helm Chart](https://github.com/sentry-kubernetes/charts/blob/sentry-v26.21.0/charts/sentry/Chart.yaml). Thanks to this chart, deploying all components to your cluster is fast and straightforward.

## Overriding Helm Values

In my case, I needed to override the Helm values to set tolerations for all components in the self-hosted Sentry setup. If you check the [Sentry Chart values](https://github.com/sentry-kubernetes/charts/blob/sentry-v26.21.0/charts/sentry/values.yaml), you’ll find the toleration configuration under the global section. You can add your required tolerations there.

However, that’s not the whole story. If you look at the [Chart.yaml](https://github.com/sentry-kubernetes/charts/blob/sentry-v26.21.0/charts/sentry/Chart.yaml), you’ll see that there are many dependent charts. The global configuration doesn’t automatically override tolerations for all of these dependencies, so you need to define them separately for each one.

`chart.yaml`

```yaml
apiVersion: v2
name: sentry
description: A Helm chart for Kubernetes
type: application
version: 26.21.0
appVersion: 25.5.1
dependencies:
  - name: memcached
    repository: oci://registry-1.docker.io/bitnamicharts
    version: 7.5.2
    condition: sourcemaps.enabled
  - name: redis
    repository: oci://registry-1.docker.io/bitnamicharts
    version: 17.11.3
    condition: redis.enabled
  - name: kafka
    repository: oci://registry-1.docker.io/bitnamicharts
    version: 29.3.14
    condition: kafka.enabled
  - name: clickhouse
    repository: https://sentry-kubernetes.github.io/charts
    version: 3.14.1
    condition: clickhouse.enabled
  - name: zookeeper
    repository: oci://registry-1.docker.io/bitnamicharts
    version: 11.4.11
    condition: zookeeper.enabled
  - name: rabbitmq
    repository: oci://registry-1.docker.io/bitnamicharts
    version: 11.16.2
    alias: rabbitmq
    condition: rabbitmq.enabled
  - name: postgresql
    repository: oci://registry-1.docker.io/bitnamicharts
    version: 12.5.1
    condition: postgresql.enabled
  - name: nginx
    repository: oci://registry-1.docker.io/bitnamicharts
    version: 18.2.5
    condition: nginx.enabled
maintainers:
  - name: sentry-kubernetes
```

## Using Gemini

Manually checking all the dependent chart values and adding tolerations can be a tedious task. So, I thought—why not leverage AI to help? I prompted Gemini 2.5 Pro on the Web Console with the following:

> Please provide the values.yaml configuration to add tolerations to all components in the Sentry Helm chart, version 26.21.0. The chart can be found at: https://github.com/sentry-kubernetes/charts/tree/develop/charts/sentry.

Gemini generated a fairly good values.yaml, but it wasn’t perfect. Even though I included the URL in the prompt, it didn’t seem to thoroughly check all the dependent charts.

For example, it included tolerations for Kafka like this. However, the Kafka chart doesn’t actually support a top-level tolerations configuration, so this wouldn’t work.

```yaml
kafka:
  enabled: true
  tolerations:
    - key: 'your-key'
      operator: 'Exists'
      effect: 'NoSchedule'
```

It also missed the fact that the global section can be used for all templates provided by the Sentry Helm chart itself, which could simplify the configuration. However, when I used the same prompt with Gemini later, it correctly recognized the global section and simply added the tolerations there.

## Giving More Context

To address the issues mentioned earlier, I tried providing more context using the Gemini CLI. First, I downloaded the Sentry Helm chart along with all its dependent Helm charts.

```sh
helm repo add sentry https://sentry-kubernetes.github.io/charts
helm pull sentry/sentry --untar
helm dependency build sentry --skip-refresh
```

In Gemini CLI, you can include all files in a specific directory by using the `@` symbol, like this:

> can you generate helm values.yaml to add tolerations to all compenents in sentry when I install it with sentry helm chart? all helm charts are located in @sentry you can generate precise values.yaml with the files.

At first, Gemini correctly identified the global configuration option and understood that it could be applied to all templates within the Sentry Helm chart. However, it missed adding tolerations to the dependent Helm charts.

```sh
 1 # This values.yaml adds tolerations to all components deployed by the Sentry Helm chart.
 2 # You can customize the key, value, and effect to match the taints on your nodes.
 3 global:
 4   tolerations:
 5     # This toleration allows pods to be scheduled on nodes with the taint:
 6     # key: "dedicated", value: "sentry", effect: "NoSchedule"
 7     - key: "dedicated"
 8       operator: "Equal"
 9       value: "sentry"
10       effect: "NoSchedule"
11     # This toleration allows pods to be scheduled on nodes with any taint that has the key "project"
12     # regardless of the taint's value, with effect "NoExecute"
13     - key: "project"
14       operator: "Exists"
15       effect: "NoExecute"
16
17 # You can also add tolerations to specific components if needed.
18 # For example, to add a toleration only to the web component:
19 # sentry:
20 #   web:
21 #     tolerations:
22 #       - key: "web-only"
23 #         operator: "Exists"
24 #         effect: "NoSchedule"
```

I then gave a more specific prompt to address that:

> you need to add tolerations to dependent helm charts too.

```bash
 1 # This values.yaml adds a toleration to all Sentry components and their dependencies.
 2 # The toleration allows pods to be scheduled on nodes with the taint:
 3 # key: "dedicated", value: "sentry", effect: "NoSchedule"
 4
 5 # This global toleration applies to all Sentry-specific components
 6 # (web, workers, cron, relay, snuba, symbolicator, etc.) and hooks.
 7 global:
 8   tolerations:
 9     - key: "dedicated"
10       operator: "Equal"
11       value: "sentry"
12       effect: "NoSchedule"
13
14 # The following sections apply the same toleration to each of the dependent charts.
15 clickhouse:
16   tolerations:
17     - key: "dedicated"
18       operator: "Equal"
19       value: "sentry"
20       effect: "NoSchedule"
21
22 kafka:
23   controller:
24     tolerations:
25       - key: "dedicated"
26         operator: "Equal"
27         value: "sentry"
28         effect: "NoSchedule"
29   broker:
30     tolerations:
31       - key: "dedicated"
32         operator: "Equal"
33         value: "sentry"
34         effect: "NoSchedule"
35
36 memcached:
37   tolerations:
38     - key: "dedicated"
39       operator: "Equal"
40       value: "sentry"
41       effect: "NoSchedule"
42
43 nginx:
44   tolerations:
45     - key: "dedicated"
46       operator: "Equal"
47       value: "sentry"
48       effect: "NoSchedule"
49
50 postgresql:
51   primary:
52     tolerations:
53       - key: "dedicated"
54         operator: "Equal"
55         value: "sentry"
56         effect: "NoSchedule"
57   readReplicas:
58     tolerations:
59       - key: "dedicated"
60         operator: "Equal"
61         value: "sentry"
62         effect: "NoSchedule"
63
64 rabbitmq:
65   tolerations:
66     - key: "dedicated"
67       operator: "Equal"
68       value: "sentry"
69       effect: "NoSchedule"
70
71 redis:
72   master:
73     tolerations:
74       - key: "dedicated"
75         operator: "Equal"
76         value: "sentry"
77         effect: "NoSchedule"
78   replica:
79     tolerations:
80       - key: "dedicated"
81         operator: "Equal"
82         value: "sentry"
83         effect: "NoSchedule"
84
85 zookeeper:
86   tolerations:
87     - key: "dedicated"
88       operator: "Equal"
89       value: "sentry"
90       effect: "NoSchedule"
```

This time, Gemini correctly set up tolerations for the Kafka dependent chart. I proceeded to install Sentry using the generated values.yaml file. However, the Kafka provisioning job wasn’t scheduled correctly due to taints on the node.

I prompted Gemini again to fix the issue, and it finally returned a working values.yaml file with all necessary tolerations correctly applied.

> you missed adding tolearations to sentry-kafka-provisioning

```yaml
kafka:
  controller:
    tolerations:
      - key: 'dedicated'
        operator: 'Equal'
        value: 'sentry'
        effect: 'NoSchedule'
  broker:
    tolerations:
      - key: 'dedicated'
        operator: 'Equal'
        value: 'sentry'
        effect: 'NoSchedule'
  provisioning:
    tolerations:
      - key: 'dedicated'
        operator: 'Equal'
        value: 'sentry'
        effect: 'NoSchedule'
```

## Burning Out Tokens

Well, it didn’t generate a working values.yaml on the first try. That made me question which approach is more efficient: generating the file with AI or manually configuring it by reviewing each dependent Helm chart.

Even though Gemini offers a generous token limit, it felt wasteful for this task. it read 595 files!

```
Successfully read and concatenated content from **593 file(s)**.
```

I tried reducing the number of files by deleting everything except the `values.yaml` and `Chart.yaml` files.

```bash
find ./sentry -type f ! \( -name 'values.yaml' -o -name 'Chart.yaml' \) -delet
```

However, in this case, Gemini didn’t recognize the global section and kept trying to apply tolerations to each individual component using the global configuration incorrectly. I tried refining the prompt several times, but eventually, I gave up.

## Conclusion

I often write values.yaml files to install open-source projects on Kubernetes clusters. This time, I needed to add tolerations to ensure all components of Sentry would run on specific nodes. Since Sentry has quite a few components, I decided to leverage Gemini to generate the values.yaml file more quickly.

However, the generated file wasn’t accurate, and it took some experimentation to improve the results. I tried adding all the Helm chart files to the context, which did help Gemini provide better answers—but at the cost of processing a large number of files and consuming a lot of tokens for a relatively simple task.

I then reduced the number of files, keeping only the values.yaml and Chart.yaml files, and continued experimenting. Unfortunately, the results still didn’t meet my expectations. In the end, I decided to stop experimenting and leave the issue unresolved for now.
