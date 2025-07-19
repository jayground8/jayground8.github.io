---
title: 'How To Authenticate With Docker API'
date: '2025-07-16'
tags: ['docker', 'Gemini', 'Claude']
images: ['/static/images/thumbnail/write-bash-script.png']
summary: "I needed to iterate through all image repositories in my private container registry, find the latest build for each, and save them as individual tar files. Although an LLM can generate code for this task quickly, it's worth knowing how to issue an authentication token for the Docker API. This could be important for guiding the LLM to produce a correct final version."
---

I needed to write a simple bash script to iterate through all the image repositories in my private container registry, find the latest build for each, and save them as individual .tar files. I didn't want to do this manually because there are too many images, and I knew I would have to do it again later.

Since we're in the age of AI, I asked an LLM to generate the script. Instead of trying to remember all the bash syntax, an LLM can generate code in just a few seconds. However, it's common to encounter errors when you run the generated script. You then have to report the errors back to the AI to fix the problem, sometimes repeating the process over and over. This shows how important it is to give LLMs clear and correct instructions.

For instance, when I asked Gemini to generate a script for this task, the code it produced was almost perfect. But depending on how you write the prompt, it can miss crucial steps. In my case, it initially forgot to include the function to generate an authentication token.

## How To Authenticate

You can get information on how to authenticate to your registry from the Www-Authenticate response header. For example, if your registry supports the Docker V2 API, an unauthenticated request to list an image's tags will fail.

```bash
curl -i "https://my-private-repository.com/v2/$name/tags/list"
```

You'll get a 401 Unauthorized status code back, and the response will include a Www-Authenticate header. This header contains information about where you need to request a token (realm), and which service and scope to use. This information can vary depending on the container registry.

```bash
www-authenticate: Bearer realm="https://my-private-repository.com/auth/token",service="ncr",scope="repository:tutorial:pull"
```

With this information, you can get an authentication token using basic authentication, like so:

```bash
curl -u "$USERNAME:$PASSWORD" "https://my-private-repository.com/auth/token?service=ncr&scope=repository:tutorial:pull"
```

Now that you have the token, you can make an authorized request to get all the tags.

```bash
curl -H "Authorization: Bearer ${TOKEN}" "https://my-private-repository.com/v2/$name$/tags/list"
```

You can get a list of all image repositories in your container registry using the `v2/_catalog` API. However, the Www-Authenticate header for this endpoint doesn't explicitly state the required scope.

```bash
curl -i https://my-private-repository.com/v2/_catalog
```

```bash
www-authenticate: Bearer realm="https://my-private-repository.com/auth/token",service="ncr"
```

To get a token with the correct permissions, you must set the scope to registry:catalog:\*.

```bash
curl -u "$USERNAME:$PASSWORD" "https://my-private-repository.com/auth/token?service=ncr&scope=registry:catalog:*"
```

## Generating with LLM

From the explanation above, you probably have a good idea of the process. You can get a list of all image repositories from your container registry using the `v2/_catalog` API and then iterate through them to find the latest build for each. You also know that you need to authenticate with the private registry and how to do it.

Now, let's have an LLM do the work.

### Claude Sonnet 4

My first prompt was:

> please write a bash script. I needed to iterate through all image repositories in my private container registry, find the latest build for each, and save them as individual tar files.

Claude generated a nice bash script. However, instead of first requesting a token from the realm URL, the script attempted to use basic authentication for every API call.

```bash
get_repositories() {
    local auth_header
    auth_header=$(echo -n "$REGISTRY_USERNAME:$REGISTRY_PASSWORD" | base64)

    log "Fetching repository list from registry..."

    # For Docker Registry API v2
    local repos_url="https://$REGISTRY_URL/v2/_catalog"

    if ! curl -s -H "Authorization: Basic $auth_header" "$repos_url" | jq -r '.repositories[]' 2>/dev/null; then
        error "Failed to fetch repositories. Make sure your registry supports Docker Registry API v2"
        exit 1
    fi
}
```

After I gave it additional guidance, it generated the code I was expecting.

> basic authentication is not working. You should issue a authentication token to authenticate to API.

```bash
get_auth_token() {
    local service="$1"
    local scope="$2"

    # First, try to get the authentication realm from the registry
    local auth_challenge
    auth_challenge=$(curl -s -I "https://$REGISTRY_URL/v2/" | grep -i "www-authenticate" | head -1)

    if [[ -z "$auth_challenge" ]]; then
        error "Could not get authentication challenge from registry"
        exit 1
    fi

    # Extract realm, service, and scope from the challenge
    local realm
    realm=$(echo "$auth_challenge" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')

    if [[ -z "$realm" ]]; then
        error "Could not extract authentication realm"
        exit 1
    fi

    log "Getting authentication token from: $realm"

    # Request token with proper parameters
    local token_url="$realm"
    local token_params="service=$service"

    if [[ -n "$scope" ]]; then
        token_params="$token_params&scope=$scope"
    fi

    local token_response
    token_response=$(curl -s -u "$REGISTRY_USERNAME:$REGISTRY_PASSWORD" "$token_url?$token_params")

    if [[ $? -ne 0 ]]; then
        error "Failed to get authentication token"
        exit 1
    fi

    # Extract token from response
    local token
    token=$(echo "$token_response" | jq -r '.token // .access_token' 2>/dev/null)

    if [[ -z "$token" || "$token" == "null" ]]; then
        error "Could not extract token from response"
        exit 1
    fi

    echo "$token"
}
```

I had to provide more instructions to fix other parts as well. For instance, Claude initially interpreted "latest build" as simply getting the image with the tag name "latest". In the end, the script was able to retrieve all image repositories and find the true latest build by using two additional API calls: `v2/${repo}/manifests/${tag}` and `v2/${repo}/blobs/${config_digest}`.

### Gemini 2.5 Pro

I prefer to use Gemini because its token allowance is more generous, and I don't have to pay extra on my current plan. I sent the same prompt to Gemini.

> please write a bash script. I needed to iterate through all image repositories in my private container registry, find the latest build for each, and save them as individual tar files.

It turned out that the authentication part was completely missing, so I provided an additional instruction.

> it need to issue a token to authenticate to my private container registry.

However, this time it just defined an AUTH_URL variable instead of getting it dynamically from the Www-Authenticate header. I had to give it a more specific instruction.

> you need to get auth url from www-authenticate insead.

Just like with Claude, I had to chat a little bit more with Gemini to fix minor issues. In the end, the result was quite similar.

## Conclusion

Gemini and Claude did the boring job of writing a simple bash script for me. However, they didn't generate perfect code on the first try. It was worthwhile to understand how authentication works with the www-authenticate response header and the Docker API. Based on this knowledge, you can give the LLM more specific guidance to generate a final, working version of the code.
