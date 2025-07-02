---
title: 'Building Flutter App through Gemini CLI'
date: '2025-07-3'
tags: ['ai', 'hackathon']
images: ['/static/images/thumbnail/ai-hackathon.png']
summary: "I recently had the valuable opportunity to experience building a Flutter application from scratch using Gemini CLI at my company's one-day AI hackathon. It was an insightful experience to understand vibe coding firsthand. This also gave me thoughts on what skills I need to continue developing in the AI era."
---

## AI Hackathon: My Vibe Coding Journey

At my company, we recently dedicated a day for employees to engage in "vibe coding" – building any product they envisioned using the latest AI models like Claude Max or other LLM services. This initiative wasn't just for developers; it encouraged members from non-engineering departments, such as Designers and Project Managers, to explore how AI tools could enhance their daily work efficiency.

## My Product Idea: Personalized English Learning for Kids

I seized this valuable opportunity to develop a web application aimed at providing more personalized English learning content for children. My eldest son had just started using my company's existing English learning product a few months prior. Observing his interactions firsthand sparked numerous ideas and deepened my involvement. I strongly felt that more personalized content could significantly boost a child's engagement in the learning process.

Imagine parents being able to select topics based on their child's recent experiences. For instance, if a child had a soccer match last night, parents could input this information into a dashboard, and the child would then engage in learning activities within the application related to that soccer match. Similarly, if parents planned to cook together, they could select "cooking" as a topic, allowing the child to learn relevant vocabulary and concepts. Later, during the actual cooking session, they could discuss what they learned from the application, reinforcing the new knowledge. I firmly believe that learning is most effective when applied to real-life situations.

## Why I Chose Gemini CLI

My goal for "vibe coding" was to build an application entirely by asking an LLM to generate and fix the code, without directly editing it myself in an editor. I chose Gemini CLI over Claude Max for a couple of reasons. Firstly, many of my colleagues opted for Claude Max, and I wanted to explore a different LLM to broaden our collective reference points. Secondly, Claude Max incurred extra costs, and its token allowance was quickly exhausted. Gemini, on the other hand, offered a generous volume of free tokens, which I considered a more sustainable option for long-term employee use.

## Version 0.0.1: Content Generation via Gemini

My initial request to Gemini was to create a Flutter application that would allow users to input their child's information (name, age, nationality) and select a fruit. Based on this input, Gemini was to generate short English learning content. I instructed Gemini to display the content sentence by sentence, automatically advancing to the next sentence after five seconds. I also added a visual cue: a yellow sign appearing two seconds before the transition to the next sentence.

Up to this point, creating the application to meet my requirements was surprisingly quick and easy. I committed this initial code and tagged it as 0.0.1 on Git. I did encounter a subtle annoyance in the process, though: Gemini CLI frequently attempted to override my API key value and LLM model name. To counter this, I created a GEMINI.md file to instruct Gemini not to override specific values.

## Version 0.0.2: Adding Google TTS Audio

However, I encountered a significant hurdle when I asked Gemini to add a text-to-speech (TTS) feature. The built-in browser TTS service often sounds unnatural, so I specifically requested the use of Google Text-to-Speech. Although Gemini generated the code, running the Flutter application resulted in errors. Despite several attempts from Gemini to fix these, the problem persisted.

It appeared that the google_generative_ai Flutter package (which I was using for LLM interaction) had a dependency conflict with the cloud_text_to_speech package, preventing the use of the latest cloud_text_to_speech version. I tried specifying compatible package versions, but the issue remained. Even requesting alternative Flutter packages didn't resolve the persistent error messages.

Ultimately, I asked Gemini to generate code that would make direct REST API requests to the Google TTS service, bypassing any problematic packages. This finally worked! While my main goal for this project was to build the application solely through commanding Gemini to generate code, the repeated error messages were quite frustrating. After these struggles, I managed to mark the source code as 0.0.2 on Git.

My next ambition was to control the voice generation through SSML (Speech Synthesis Markup Language) to achieve a more natural and context-aware delivery. I asked Gemini to generate SSML alongside the content and send it to Google TTS. Unfortunately, Google TTS seemed to interpret the SSML syntax literally, speaking out "slash something slash..." instead of applying the markup. I then asked Gemini to create linter and validation logic to prevent the translation of this syntax into audio. Despite numerous attempts and different approaches, the errors or malfunctions (like generating audio for syntax) continued. After much trying, I eventually gave up on this feature and decided to move on.

## Version 0.0.3: Image Generation Matching Content

The final feature I aimed to implement was generating an image based on the story content. At that time, Gemini 2.5's image generation model was not available via API, so I had to use the "gemini-2.0-flash-preview-image-generation" model. I asked Gemini to generate an image based on each sentence and display it on the screen concurrently. It utilized the google_generative_ai Flutter package for this.

However, the generated code included invalid configuration options. After many attempts to fix this, I discovered that the model required specific configurations, but the google_generative_ai Flutter package somehow lacked the correct attributes for the relevant class. I suspected this might be due to deprecation, so I tried downgrading the package version, but the configuration option was missing in other versions as well. I was stuck again.

Finally, I asked Gemini to write code to make a direct REST API request without relying on the package. The problem, however, was that even with REST API calls, it still tried to send incorrect configurations. Despite sharing a link of the documentation with example REST API schemas, Gemini continued to set up the code incorrectly. At this point, I truly tried hard not to edit the code myself, but I eventually had to fix it manually in the editor. Finally, the features I wanted were successfully integrated into the application. I marked this code 0.0.3.

## Extra: Enhancing UI Design

My initial plan also included sketching UI designs on paper or a laptop and then generating the UI code directly from these sketch files. While my initial tests for generating HTML code from sketches looked promising, however time ran out after reaching 0.0.3. We then transitioned into wrap-up sessions to share each team's ideas and results.

## Sharing Final Results at Wrap-Up Sessions

I thoroughly enjoyed observing my colleagues' ideas and their final results. It was fascinating to see many diverse products emerge from scratch, with some even addressing real problems faced by people within our company. I could clearly see that very general websites could be built quickly and efficiently with Claude or Gemini. Our CTO, for instance, managed to build a dashboard website to register teams, input product information, and even add a voting system for members to select their top three favorite teams, all within an hour.

However, some designers and frontend developers were not entirely satisfied with the UI generated by the LLMs. Some tried different AI services to generate pretty UI designs first and then asked Claude to add features on top of that UI scaffold. Others opted to customize the UI results more extensively to match their visual preferences. In general, it was valuable time spent experimenting with the latest Claude Max and Gemini models firsthand, and realizing how well these models can handle requests for writing code and building applications from scratch. Nevertheless, we also acknowledged the current shortcomings of LLMs when it comes to building applications solely through AI.

## My Thoughts: Leveling Up in the AI Era

On my journey to build an application solely using Gemini CLI, I encountered several struggles. Gemini had a difficult time handling unusual situations, such as version conflicts or packages in certain runtimes that didn't support specific model configurations. It repeatedly generated the same patterns, even when I pointed out the inaccuracies. I shared error messages, but it seemed to fall into a loop of generating other errors. It also lacked the ability to suggest using REST API instead of a package to solve a problem. I had to guide Gemini to resolve issues, and at certain points, I had to fix the code myself.

Gemini sometimes referred to outdated documentation or API schema specifications. Even when I provided reference links to follow the documentation for requests and response parsing, it still generated incorrect code. I genuinely tried hard not to edit the code myself, but this time, I had to fix it manually in the editor.

This experience reinforced a crucial realization: you are the captain of the ship, holding the helm. The ship's direction is entirely dependent on your control. If your steering is off, the ship can get lost or veer towards a completely different destination. This is why I am now focusing on leveling up my skills in system design and architecture, and developing a keen sense to identify the most impactful work for my business or company, and then effectively manage that process as a team.
