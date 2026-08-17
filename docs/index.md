---
layout: home

hero:
  name: Pi Docker Sandboxes
  text: Run Pi in an isolated microVM
  tagline: Tested on macOS 26.5.2 Apple Silicon; other macOS releases are not yet validated or supported during Early Access.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Install
      link: /getting-started#install-and-diagnose
    - theme: alt
      text: View on GitHub
      link: https://github.com/gurkanguray/pi-docker-sandboxes

features:
  - title: Isolated by default
    details: Pi, extensions, and subprocesses run inside a Docker Sandboxes microVM.
  - title: Safe host boundary
    details: Host source stays read-only; changes return through reviewed patch export and apply.
  - title: Early Access
    details: Tested on macOS 26.5.2 Apple Silicon with Pi 0.84.1, Node.js 24.12.0, Docker Engine 29.7.1, and Docker Sandboxes (`sbx`) 0.38.0. Other macOS releases, Linux, and Windows are unsupported.
---
