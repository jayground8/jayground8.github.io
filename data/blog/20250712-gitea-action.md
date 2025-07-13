---
title: 'Gitea Actions'
date: '2025-07-12'
tags: ['gitea']
images: ['/static/images/thumbnail/gitea.png']
summary: "I needed to set up a self-hosted Git system and was looking for an open-source tool that would fit my requirements. Gitea seemed like a great fit, and I was particularly interested in Gitea Actions, which is compatible with GitHub Actions. However, I struggled to correctly configure a Gitea Actions runner to use a container image from a private repository. Through that process, I gained a much better understanding of how Gitea offers a CI/CD system compatible with GitHub Actions. In this post, I'll share what I learned."
---

## Reason Why I Picked Gitea

I needed to run a self-hosted Git system instead of using a SaaS platform like GitHub or Bitbucket. My main requirements were that the solution be open-source and have a great web UI.

At first, GitHub Enterprise and GitLab Community Edition came to mind. However, GitHub Enterprise isn't open-source, which led me to believe that GitLab CE was the only option that met my criteria.

After a little more research, I found Gitea. A quick check revealed that it not only has a great web UI but also provides a CI/CD pipeline compatible with GitHub Actions. It also offers support for Git LFS and OAuth2 authentication.

I also prefer open-source projects that are maintained by a company that offers an enterprise version, as I believe this ensures better long-term reliability. Gitea fits this preference, with an enterprise option provided by the company CommitGo.

Finally, Gitea has a simpler architecture with fewer components (Gitea, PostgreSQL, Valkey, and an Act Runner) compared to GitLab. This was important to me because I sometimes need to modify Dockerfiles and build images from source to meet specific security requirements. For that reason, a system with fewer components was an advantage.

## Act

Gitea provides a CI/CD pipeline compatible with GitHub Actions by using the [open-source project Act](https://github.com/nektos/act). Act allows you to run GitHub Action workflows on your local machine by parsing the workflow specification and running it in a container environment via the Docker API. While GitHub Actions operate in a virtualized environment, Act uses a container environment, and the container it uses is called a Runner. You can configure which container image to use for this Runner.

Act provides a CLI that allows you to run workflows on your local machine. If Docker is running on your system, this single command will run the workflow specified in a file like ~/.github/workflows/something.yml. It's awesome!

```sh
act
```

Gitea forked "Act" and modified it to be used as a library for its own [Gitea Act Runner](https://gitea.com/gitea/act_runner). The Gitea Act Runner integrates with Gitea and runs workflows using this forked Act library. Gitea Act reads workflow files from the .gitea/workflows path instead of .github/workflows. However, the workflow specification is still compatible with GitHub Actions. That's why you can run your Gitea workflows with the Act CLI using the -W option, like below.

```sh
act -W ./.gitea/workflows/
```

## Private Image For Runner

[The Gitea Act Runner repository has examples for running it on Kubernetes](https://gitea.com/gitea/act_runner/src/tag/v0.2.12/examples/kubernetes/dind-docker.yaml). I started with the dind-docker.yaml example, and it was working great! In this setup, a container with the Docker-in-Docker (DinD) image runs as a sidecar. The Act Runner container communicates with this DinD container and creates new containers within it through the Gitea Act library.

This process was quick and smooth until I tried to use a container image from a private repository for my Runner. To run your own container image as a runner, you add it to the labels in the configuration.

```yaml
data:
  config.yaml: |
    log:
      level: debug

    runner:
      file: .runner
      capacity: 1
      timeout: 3h
      shutdown_timeout: 0s
      insecure: false
      fetch_timeout: 5s
      fetch_interval: 2s
      labels:
        - "ubuntu-latest:docker://docker.gitea.com/runner-images:ubuntu-latest"
        - "ubuntu-22.04:docker://my-private-repository.com/ubuntu:22.04"

    cache:
      enabled: false

    container:
      privileged: true
      docker_host: tcp://localhost:2376
      force_pull: false
      force_rebuild: false
```

I created a Kubernetes secret in the docker-registry format (`kubectl create secret docker-registry regcred`) to authenticate with my private container registry. My first thought was that the DinD container needed these credentials, so I mounted the secret volume onto that container. This assumption cost me a significant amount of time and led me down a rabbit hole into the source code. 🥹

```yaml
- name: docker-config
    secret:
        secretName: regcred
```

```yaml
- name: docker-config
    mountPath: /root/.docker/config.json
    subPath: .dockerconfigjson
    readOnly: true
```

## How To Load Docker Config File

To cut to the chase, the Gitea Act Runner container needs the Docker authentication credentials, not the DinD container. The Act library itself is responsible for pulling images and running containers through the Docker API. Therefore, the Act Runner must be the one to make the authenticated request to the Docker daemon.

You can understand this better by looking at [the source code of Gitea Act](https://gitea.com/gitea/act/src/commit/9924aea78631d3e4e24a0eefb522e0aab1e7f4ab/pkg/container/docker_pull.go), specifically the LoadDockerAuthConfig method. It loads credentials from a .docker/config.json file and attaches them to the request for authentication.

```go
func getImagePullOptions(ctx context.Context, input NewDockerPullExecutorInput) (types.ImagePullOptions, error) {
	imagePullOptions := types.ImagePullOptions{
		Platform: input.Platform,
	}
	logger := common.Logger(ctx)

	if input.Username != "" && input.Password != "" {
		logger.Debugf("using authentication for docker pull")

		authConfig := registry.AuthConfig{
			Username: input.Username,
			Password: input.Password,
		}

		encodedJSON, err := json.Marshal(authConfig)
		if err != nil {
			return imagePullOptions, err
		}

		imagePullOptions.RegistryAuth = base64.URLEncoding.EncodeToString(encodedJSON)
	} else {
		authConfig, err := LoadDockerAuthConfig(ctx, input.Image)
		if err != nil {
			return imagePullOptions, err
		}
		if authConfig.Username == "" && authConfig.Password == "" {
			return imagePullOptions, nil
		}
		logger.Info("using DockerAuthConfig authentication for docker pull")

		encodedJSON, err := json.Marshal(authConfig)
		if err != nil {
			return imagePullOptions, err
		}

		imagePullOptions.RegistryAuth = base64.URLEncoding.EncodeToString(encodedJSON)
	}

	return imagePullOptions, nil
}
```

## Final Version

Here is the final version of my modified Gitea example.

```yaml
kind: ConfigMap
apiVersion: v1
metadata:
  name: act-runner-config
data:
  config.yaml: |
    log:
      level: debug

    runner:
      file: .runner
      capacity: 1
      timeout: 3h
      shutdown_timeout: 0s
      insecure: false
      fetch_timeout: 5s
      fetch_interval: 2s
      labels:
        - "ubuntu-latest:docker://docker.gitea.com/runner-images:ubuntu-latest"
        - "ubuntu-22.04:docker://my-private-repository.com/ubuntu:22.04"

    cache:
      enabled: false

    container:
      privileged: true
      docker_host: tcp://localhost:2376
      force_pull: false
      force_rebuild: false
---
kind: PersistentVolumeClaim
apiVersion: v1
metadata:
  name: act-runner-vol
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 100Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: act-runner
  name: act-runner
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: act-runner
  template:
    metadata:
      creationTimestamp: null
      labels:
        app: act-runner
    spec:
      restartPolicy: Always
      volumes:
        - name: runner-config
          configMap:
            name: act-runner-config
        - name: docker-config
          secret:
            secretName: regcred
        - name: docker-certs
          emptyDir: {}
        - name: runner-data
          persistentVolumeClaim:
            claimName: act-runner-vol
      containers:
        - name: runner
          image: gitea/act_runner:nightly
          command:
            [
              'sh',
              '-c',
              "while ! nc -z localhost 2376 </dev/null; do echo 'waiting for docker daemon...'; sleep 5; done; /sbin/tini -- run.sh",
            ]
          env:
            - name: DOCKER_HOST
              value: tcp://localhost:2376
            - name: DOCKER_CERT_PATH
              value: /certs/client
            - name: DOCKER_TLS_VERIFY
              value: '1'
            - name: GITEA_INSTANCE_URL
              value: http://gitea-http.gitea.svc.cluster.local:3000
            - name: GITEA_RUNNER_REGISTRATION_TOKEN
              value: { registration_token }
            - name: CONFIG_FILE
              value: /etc/runner/config.yaml
          volumeMounts:
            - name: runner-config
              mountPath: /etc/runner/config.yaml
              subPath: config.yaml
              readOnly: true
            - name: docker-certs
              mountPath: /certs
            - name: runner-data
              mountPath: /data
            - name: docker-config
              mountPath: /root/.docker/config.json
              subPath: .dockerconfigjson
              readOnly: true
        - name: daemon
          image: docker:23.0.6-dind
          env:
            - name: DOCKER_TLS_CERTDIR
              value: /certs
          securityContext:
            privileged: true
          volumeMounts:
            - name: docker-certs
              mountPath: /certs
```

When your workflow uses the ubuntu-22.04 label, as shown below, the runner will pull the corresponding container image from the private registry you configured.

```yaml
name: Gitea Actions Demo
run-name: ${{ gitea.actor }} is testing out Gitea Actions 🚀
on: [push]

jobs:
  Explore-Gitea-Actions:
    runs-on: ubuntu-22.04
    steps:
```

## Try Setting Up With Gemini CLI

I've realized I should be leveraging AI services more to improve my daily work efficiency. I've also learned that I need to experiment to find better ways to prompt LLMs. With that in mind, I tried using Gemini to set up a private container image in Gitea Runner.

My first prompt to the Gemini CLI was to modify the example file to use a private container image.

> This YAML file runs a Gitea Runner on Kubernetes. Gitea Runner is currently set up to run a runner using a public container image by default. Please change it to use a private image instead. The image should be ubuntu:24.04 from the repository example.com. @dind-docker.yaml

However, it tried to solve the problem by adding environment variables that don't exist in the Gitea Runner.

```yaml
- name: RUNNER_CONTAINER_IMAGE
	value: example.com/ubuntu:24.04
- name: RUNNER_CONTAINER_USERNAME
	valueFrom:
		secretKeyRef:
			name: runner-secret
			key: username
- name: RUNNER_CONTAINER_PASSWORD
	valueFrom:
		secretKeyRef:
			name: runner-secret
			key: password
```

Next, I asked it to create a new Kubernetes manifest from scratch without providing an example, but it generated the same incorrect response.

I noticed some strange behavior. I confirmed that both the Gemini CLI and the gemini.google.com web console were set to use Gemini 2.5 Pro. However, when I submitted the same prompt to the web console, it produced a different result.🤔 It correctly added a label for the private image in the runner's configuration and mounted the Docker config file for authentication.

```yaml
# -------------------
# 1. Secret for Private Repository Authentication
# -------------------
# Remember to create this with your actual credentials using kubectl:
# kubectl create secret docker-registry regcred \
#   --docker-server=example.com \
#   --docker-username=<your-username> \
#   --docker-password=<your-password>
#
# This is a placeholder manifest for reference.
apiVersion: v1
kind: Secret
metadata:
  name: regcred
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: eyJhdXRocyI6eyJleGFtcGxlLmNvbSI6eyJhdXRoIjoiWVdSdGFXNDZNVEE1T1RrNU9USXpPRGsyIn19fQ== # This is a placeholder for your encoded credentials

---
# -------------------
# 2. ConfigMap for Gitea Runner Configuration
# -------------------
apiVersion: v1
kind: ConfigMap
metadata:
  name: gitea-runner-config
data:
  config.yaml: |
    # Gitea server connection details
    gitea:
      instance: "https://your-gitea-instance.com"
      token: "YOUR_RUNNER_TOKEN" # Replace with your Gitea runner token
      insecure: false

    runner:
      # The name of the runner
      name: "k8s-runner"
      # This section maps a friendly name to a container image for jobs
      labels:
        # This is the new label for your private image
        - "ubuntu-24.04:docker://example.com/ubuntu:24.04"
        # You can keep other labels for public images
        - "ubuntu-latest:docker://gitea/runner-images/ubuntu-latest"

    # Settings for the container runner
    container:
      # Use docker-in-docker sidecar
      docker_host: "tcp://localhost:2375"

---
# -------------------
# 3. Deployment for the Gitea Runner
# -------------------
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gitea-runner-deployment
spec:
  replicas: 1
  selector:
    matchLabels:
      app: gitea-runner
  template:
    metadata:
      labels:
        app: gitea-runner
    spec:
      containers:
        # Main Gitea Runner container
        - name: runner
          image: gitea/act_runner:latest
          env:
            - name: CONFIG_FILE
              value: /config/config.yaml
          volumeMounts:
            # Mount the ConfigMap containing config.yaml
            - name: config-volume
              mountPath: /config
            # Mount the Docker credentials into the runner's home directory
            # This allows the runner to authenticate when pulling job images
            - name: docker-config
              mountPath: /root/.docker
              readOnly: true
        # Docker-in-Docker sidecar container
        - name: dind
          image: docker:dind
          securityContext:
            privileged: true
          volumeMounts:
            - name: docker-graph-storage
              mountPath: /var/lib/docker
      volumes:
        # Volume for the ConfigMap
        - name: config-volume
          configMap:
            name: gitea-runner-config
        # Volume for the Docker credentials Secret
        - name: docker-config
          secret:
            secretName: regcred
        # EmptyDir volume for Docker-in-Docker storage
        - name: docker-graph-storage
          emptyDir: {}
```

## Conclusion

In the end, I chose Gitea for my self-hosted Git system. Although I initially struggled to set up the Docker credentials correctly, the process led me to discover the fascinating open-source project, Act.

Understanding how Act works helped me realize that the Gitea Act Runner loads the Docker configuration file and passes it to the Docker daemon via the API. My journey with Gitea has just begun!
