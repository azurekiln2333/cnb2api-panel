# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory contains guidelines for backend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | File partitions, encrypted credentials, migration and recovery | Implemented |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Deployment](./deployment.md) | Compose naming, scoped image updates, release packaging | Implemented |
| [Session Routing](./routing.md) | Session affinity, eligibility and bounded bindings | Implemented |
| [Logging Guidelines](./logging-guidelines.md) | Separate request/audit/runtime logs, bounded previews and retention | Implemented |
| [Request Overrides](./request-overrides.md) | Request transformation, safe header carrier and diagnostics | Implemented |
| [OIDC Authentication](./oidc-authentication.md) | Management sessions, SSO settings, provider validation | Implemented |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
