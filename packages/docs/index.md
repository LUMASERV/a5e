---
layout: home

hero:
  name: A5E
  text: A Kubernetes-native Ansible Semaphore alternative
  tagline: Hosts, inventories, playbooks, SSH keys, scheduled jobs, and playbook runs — all modeled as Kubernetes Custom Resources, reconciled by an operator, and managed from a Vue-based UI.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/LUMASERV/a5e

features:
  - icon: 🧩
    title: Everything is a Custom Resource
    details: AnsibleHost, AnsibleInventory, AnsiblePlaybook, AnsibleSSHKey, AnsibleRun, and AnsibleJob — no database, just Kubernetes objects reconciled by an operator.
  - icon: 🔐
    title: Real Kubernetes RBAC
    details: The API impersonates the logged-in user for every call, so authorization is your cluster's actual RBAC, not app-level permission bits.
  - icon: 🌐
    title: OIDC or local accounts
    details: Sign in with your identity provider or a local username/password account, with account linking by email between the two.
  - icon: 🧱
    title: Namespaced or cluster-scoped
    details: Every resource kind mirrors cert-manager's Issuer/ClusterIssuer pattern — namespaced for per-team resources, cluster-scoped for shared ones.
  - icon: 📦
    title: One Helm chart
    details: Deploy the operator, API, UI, and CRDs together, with cert-manager and ingress-allowlist support built in.
  - icon: 📜
    title: Apache 2.0
    details: Fully open source, including the operator's reconcile logic and the API's authorization model.
---
