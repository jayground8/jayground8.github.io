---
title: 'Distroless Image에 Package 추가하기'
date: '2024-07-13'
tags: ['kubernetes', 'distroless', 'devsecops']
images: ['/static/images/social-banner.png']
summary: '컨테이너 이미지에 최소한으로 필요한 software만 포함하는 것이 보안적으로 모범사례이다. 이러한 모범사례를 따르는 가장 쉽고 합리적인 방법은 구글에서 제공하는 Distroless Image를 활용하는 것이다. Distroless Image는 nonroot, debug, debug-nonroot Tag를 가지고 있다. nonroot은 conatiner에게 root 권한을 주지않고, shell도 없어서 Terminal로 접속이 불가능하다. 그런데 Distroless Image에 추가로 필요한 debian package를 설치하면 어떻게 해야할까? 이번 글에서는 bazel로 빌드할 때 원하는 debian package를 추가하는 방법을 알아 본다.'
---

컨테이너 이미지에는 최소한으로 필요한 구성요소만 넣는 것이 모범 사례이다. 컨테이너 이미지 크기가 작아져서 이미지를 보관하고 실행할 때 유리하다. 그리고 보안 관점에서는 불필요한 소프트웨어에 의해서 취약점을 노출하는 것을 방지할 수 있다. 이러한 모범 사례를 따르는 가장 쉽고 합리적인 방법은 [구글에서 공유하는 Distroless Image](https://github.com/GoogleContainerTools/distroless)를 사용하는 것이다.

[Github에서 어떻게 Python3 어플리케이션을 Distroless Image로 빌드하는지 예제](https://github.com/GoogleContainerTools/distroless/blob/main/examples/python3-requirements/Dockerfile)를 제공한다. Docker Multi-Stage 빌드방식을 통해서 필요한 python package를 깔고 최종적으로 Distroless Image를 사용한다.

```Dockerfile
FROM debian:11-slim AS build
RUN apt-get update && \
    apt-get install --no-install-suggests --no-install-recommends --yes python3-venv gcc libpython3-dev && \
    python3 -m venv /venv && \
    /venv/bin/pip install --upgrade pip setuptools wheel

# Build the virtualenv as a separate step: Only re-execute this step when requirements.txt changes
FROM build AS build-venv
COPY requirements.txt /requirements.txt
RUN /venv/bin/pip install --disable-pip-version-check -r /requirements.txt

# Copy the virtualenv into a distroless image
FROM gcr.io/distroless/python3-debian11
COPY --from=build-venv /venv /venv
COPY . /app
WORKDIR /app
ENTRYPOINT ["/venv/bin/python3", "psutil_example.py"]
```

Distroless Image에서는 nonroot, debug, debug-nonroot Tag를 제공한다. 물론 Container에 root 권한을 주지 않는 것이 모범사례이기 때문에, nonroot를 사용하는 것이 바람직하다. 기본적으로 shell을 제공하지 하지 않기 때문에 Container에 Terminal로 접근을 하지 못한다. 따라서 개발환경에서 터미널로 접근하여 디버깅를 해야할 때, debug tag를 사용해서 접근할 수 있다.

## Distroless Image Repo 확인

Distroless Image는 최소한으로 필요한 package와 binary들이 설치되어 있다. 심지어 shell 명령어로 제공되지 않아서 Terminal 접근을 할 수 없다.

그런데 어플리케이션에서 필요한 Debian package를 Distroless Image에 추가하고 싶으면 어떻게 해야할까? 🤔 구글링을 해보니 [똑같은 질문이 Github issue](https://github.com/GoogleContainerTools/distroless/issues/1321)에 있었다. 마지막 답변은 Bazel 설정값에서 원하는 debian package를 추가하여 distroless image를 빌드하는 것이다.

> Bazel is an open-source build and test tool similar to Make, Maven, and Gradle. It uses a human-readable, high-level build language. Bazel supports projects in multiple languages and builds outputs for multiple platforms. Bazel supports large codebases across multiple repositories, and large numbers of users.

[Distroless Image Github Repository](https://github.com/GoogleContainerTools/distroless/tree/main/python3)에서 보면, Python3의 경우에 아래와 같이 `BUILD`라는 파일이 보인다. `BUILD` 파일에 어떻게 bazel이 빌드해야할지 명령어가 설정되어 있다.

<img src="/static/images/distroless-image-python3.png" alt="Python3 Distroless Image" />

`BUILD` 파일을 확인해보니, oci_image에 원하는 package를 추가하면 간단하게 해결될 것처럼 보였다.

```bash
oci_image(
    name = ("python3" if (not mode) else mode[1:]) + "_" + user + "_" + arch + "_" + distro,
    # Based on //cc so that C extensions work properly.
    base = "//cc" + (mode if mode else ":cc") + "_" + user + "_" + arch + "_" + distro,
    entrypoint = [
        "/usr/bin/python" + DISTRO_VERSION[distro],
    ],
    # Use UTF-8 encoding for file system: match modern Linux
    env = {"LANG": "C.UTF-8"},
    tars = [
        deb.package(arch, distro, "libbz2-1.0"),
        deb.package(arch, distro, "libdb5.3"),
        deb.package(arch, distro, "libexpat1"),
        deb.package(arch, distro, "liblzma5"),
        deb.package(arch, distro, "libsqlite3-0"),
        deb.package(arch, distro, "libuuid1"),
        deb.package(arch, distro, "libncursesw6"),
        deb.package(arch, distro, "libtinfo6"),
        deb.package(arch, distro, "python3-distutils"),
        deb.package(arch, distro, "zlib1g"),
        deb.package(arch, distro, "libcom-err2"),
        deb.package(arch, distro, "libcrypt1"),
        deb.package(arch, distro, "libgssapi-krb5-2"),
        deb.package(arch, distro, "libk5crypto3"),
        deb.package(arch, distro, "libkeyutils1"),
        deb.package(arch, distro, "libkrb5-3"),
        deb.package(arch, distro, "libkrb5support0"),
        deb.package(arch, distro, "libnsl2"),
        deb.package(arch, distro, "libreadline8"),
        deb.package(arch, distro, "python3.11-minimal"),
        ":python_aliases_%s" % distro,
    ],
)
```

## Bazel Build

bazel을 설치하고,

```bash
brew install bazel
```

Distroless Image Github Repository를 클론한다.

```bash
git clone https://github.com/GoogleContainerTools/distroless.git
```

위에서 `BUILD` 파일에는 name이 이렇게 정의되어 있었다. bazel build 명령어를 사용할 때, `//{path}`는 BUILD 파일이 있는 경로를 의미하는 것같다. 그리고 `//{path}:{name}` 세미콜론 뒤에는 정의된 name을 넣는 것으로 보인다.

```bash
name = ("python3" if (not mode) else mode[1:]) + "_" + user + "_" + arch + "_" + distro,
```

최종적으로 root 권한이 없고, debian12를 base image로 사용하는 amd64 컨테이너 이미지를 생성하기 위해서 아래와 같이 명령어를 사용한다.

```bash
bazel build //python3:python3_nonroot_amd64_debian12
```

Bazel 빌드가 정상적으로 완료되면, 아래와 같이 파일들이 생성된다. `bazel-bin` 디렉터리 안을 보면 최종적으로 [oci 규격에 맞춰서 Image가 생성](https://github.com/opencontainers/image-spec/blob/main/image-layout.md)된 것을 확인할 수 있다.

<img src="/static/images/distroless-image-bazel-build-output.png" alt="Bazel Build Output files" />

## Debian package 추가

`ffmpeg`를 추가해야 한다고 가정해보자. 그럼 먼저 `BUILD` 파일에 아래와 같이 ffmpeg를 추가한다.

```bash
oci_image(
    name = ("python3" if (not mode) else mode[1:]) + "_" + user + "_" + arch + "_" + distro,
    # Based on //cc so that C extensions work properly.
    base = "//cc" + (mode if mode else ":cc") + "_" + user + "_" + arch + "_" + distro,
    entrypoint = [
        "/usr/bin/python" + DISTRO_VERSION[distro],
    ],
    # Use UTF-8 encoding for file system: match modern Linux
    env = {"LANG": "C.UTF-8"},
    tars = [
        ...생략
        deb.package(arch, distro, "ffmpeg"), # 추가
        ":python_aliases_%s" % distro,
    ],
)
```

그리고 `private/repos/deb` 경로에 있는 두가지 파일도 같이 수정해줘야 한다. (**아직 bazel이 익숙하지 않아서 이렇게 수동으로 수정하는 것이 맞는지는 의문이다. `_lock`이라는 suffix가 있는 것으로 봐서는 package manager로 다운로드 받고 그것에 대한 정보를 남겨 놓는 것 같다는 느낌이 든다. bazel을 잘 모르는 상태에서 이렇게 해결했다.**)

- bookworm_python.yaml
- bookworm_python_lock.json

`bookworm_python.yaml`

```yaml
packages:
  - dash
  - libbz2-1.0
  - libcom-err2
  - libcrypt1 # TODO: glibc library for -lcrypt; maybe should be in cc?
  - libdb5.3
  - libexpat1
  - libffi8
  - ffmpeg # 추가
```

`bookworm_python_lock.json`

```yaml
{
	"packages": [
		생략...
		{
			"arch": "amd64",
			"dependencies": [],
			"key": "libffi8_3.4.4-1_amd64",
			"name": "libffi8",
			"sha256": "6d9f6c25c30efccce6d4bceaa48ea86c329a3432abb360a141f76ac223a4c34a",
			"url": "https://snapshot.debian.org/archive/debian/20240706T203757Z/pool/main/libf/libffi/libffi8_3.4.4-1_amd64.deb",
			"version": "3.4.4-1"
		},
		{
			"arch": "amd64",
			"dependencies": [],
			"key": "ffmpeg_5.1.5-0_amd64",
			"name": "ffmpeg",
			"sha256": "6cdb48bab871aacf48aa13e6da0f41e14c39b834763fdd72c346a1e0b0c865a5",
			"url": "https://snapshot.debian.org/archive/debian/20240712T023630Z/pool/main/f/ffmpeg/ffmpeg_5.1.5-0+deb12u1_amd64.deb",
			"version": "5.1.5-0"
		},
		생략...
	],
	"version": 1
}
```

[Debian package tracker 페이지](https://tracker.debian.org/pkg/ffmpeg)를 보면 지금 작성하는 시점에서 `5.1.5-0+deb12u1`이 stable한 버전이었다.

<img src="/static/images/distroless-image-debian-ffmpeg.png" alt="stable version of ffmpeg package" />

그리고 다른 debian package처럼 `snapshot` 경로에서 해당 버전을 찾았다.

```bash
https://snapshot.debian.org/archive/debian/20240712T023630Z/pool/main/f/ffmpeg/
```

[sha256 checksum hash값은 debian package 다운로드 페이지](https://packages.debian.org/bookworm/amd64/ffmpeg/download)에서 찾아서 사용했다.

이제 다시 bazel build 명령어를 실행하면 해당 package가 추가되고, 최종적으로 빌드가 성공한다.

```bash
$ bazel build //python3:python3_nonroot_amd64_debian12
INFO: Analyzed target //python3:python3_nonroot_amd64_debian12 (55 packages loaded, 465 targets configured).
INFO: Found 1 target...
INFO: From Writing: bazel-out/darwin_arm64-fastbuild/bin/external/bookworm_python/ffmpeg/amd64/data_statusd.tar:
/private/var/tmp/_bazel_user/64d7a1035bb5d33ddc81222bbb467eb5/sandbox/darwin-sandbox/230/execroot/distroless/bazel-out/darwin_arm64-opt-exec-2B5CBBC6/bin/external/rules_pkg/pkg/private/tar/build_tar.runfiles/rules_pkg/pkg/private/tar/build_tar.py:29: SyntaxWarning: invalid escape sequence '\ '
  """Normalize a path to the format we need it.
Target //python3:python3_nonroot_amd64_debian12 up-to-date:
  bazel-bin/python3/python3_nonroot_amd64_debian12
INFO: Elapsed time: 7.040s, Critical Path: 1.32s
INFO: 5 processes: 2 internal, 3 darwin-sandbox.
INFO: Build completed successfully, 5 total actions
```

## OCI Image를 push

bazel build를 해서 OCI Image 규격의 구조로 만들어진 것을 확인했었다.

- blobs
- oci-layout
- index.json

해당 구조에서 image를 container registry에 push기 위해서 [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/doc/crane.md)를 사용한다.

crane push 명령어를 통해서 바로 container registry에 image push를 한다.

```bash
brew install crane
crane push bazel-bin/python3/python3_nonroot_amd64_debian12 {컨테이너 레지스티 경로}
```

## 결론

Distroless Image는 각 Runtime별로 최소한으로 필요한 Debian package가 설치되어 있다. 하지만 어플리케이션을 개발하다 보면 추가로 다른 debian package를 설치해야 할 수 있다. 감사하게도 Distroless Image Github Repository에 어떻게 bazel로 이미지를 빌드할 수 있는지 공유하고 있다. 따라서 몇 가지 파일들만 변경하여 원하는 debian package가 추가된 Distroless Image를 만들 수 있었다.
