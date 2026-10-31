# Test scope

The `.txt` sample is a real Civitai listing response supplied with this project. Tests consume it unchanged. Other fixtures are synthetic and use explicit model/version/file IDs so incorrect associations fail clearly.

The capture and background tests run generated bundles with browser API substitutes. Content tests run the generated isolated-world bundle against a DOM implementation, including recycled cards, periodic re-query with unchanged revisions, settings changes, and >500-card splitting. Swarm client tests cover the WhatTheDuck wire contract and session behavior. Collector tests verify passive capture only, with no network enrichment.

These tests do not replace reloading the installed Chrome extension and checking badges against the deployed server. Backend WhatTheDuck implementation/tests live in its independent repository and are not changed by this project.
