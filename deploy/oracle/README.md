# Oracle Vision AI — Architecture Decision

This branch (`feat/oracle-vision-ai`) builds the zero-setup AI path for SiteShrimp. The end-user no longer has to configure a provider before logging defects; SiteShrimp ships with a default that works out of the box, free-of-charge, and gets smarter over time.

## Hard constraints (the four asks)

1. **Free-of-charge** for SiteShrimp and end users. No expiring credits, no card-on-file.
2. **Speed**. Sub-second to a few seconds per photo. No CPU inference of large models.
3. **Trainable**. The chosen weights must support LoRA / QLoRA fine-tuning so that, once a CONQUAS-verified dataset exists, the model becomes project-specific.
4. **Workable for CONQUAS / A&I visual checks**. Strong JSON output adherence, decent defect-class recognition, OCR on unit signage and grid IDs.

## Selected model — **Moondream 2** (vikhyatk/moondream2)

- **Size**: 1.9 B parameters — small enough for genuinely fast inference on Oracle Ampere A1 Always Free CPU (no GPU needed).
- **License**: Apache 2.0. Commercial use, fine-tuning, and redistribution all permitted.
- **Inference latency on Ampere A1 4 OCPU + INT4 quantization**: 2-3 s per photo, steady-state. This is the speed/free/self-hosted sweet spot — larger models would require GPU or accept slow CPU.
- **Hosting**: served via Ollama (`ollama pull moondream`). Ollama is already a provider in `pb_hooks/main.pb.js` (`analyzeWithOllamaServer` at line ~540) — wiring is already there.
- **Fine-tuning ecosystem**: Unsloth, Axolotl, and the Moondream team's own training scripts. LoRA on a single consumer GPU is sufficient.
- **JSON output**: needs prompt discipline (smaller models drift from strict JSON more than 7B+ models) — we keep `parseAiResponse` validation in pb_hooks as a safety net, which it already is.

### Tradeoffs

Moondream 2 is the **fallback-tier** model. Quality expectations:

- Room matching for AUTO-TAG: solid
- Component / defect-type classification from photo: workable
- CONQUAS 1X / 2X / 3X tier assignment: marginal — the user MUST confirm, which your `[AI HITL]` memory rule already enforces
- Verbatim BCA wording: works because the prompt enforces it, not the model

Users who need flagship quality for QP-status sign-off keep the option to bring their own Gemini / OpenAI key — that path is untouched.

### Models considered and rejected

- **Llama 3.2 11B Vision via Groq** — sub-second, free tier, but not self-hosted (Groq holds the weights). Rejected because user explicitly wants self-hosted + trainable end-to-end.
- **Qwen2.5-VL-7B** — Apache 2.0, stronger quality, but 15-30 s on free-tier CPU. Too slow.
- **Qwen2.5-VL-3B** — better quality than Moondream 2 but 3-8 s vs Moondream's 2-3 s. User prioritised speed.
- **Phi-3.5-Vision** (4.2 B) — MIT license, but 4-7 s on CPU and slightly worse on basic VQA than Moondream 2 in published benchmarks.
- **Gemini 2.5 Flash free tier** — fastest zero-setup option, but you cannot own the weights or fine-tune. Fails the *trainable* constraint.

## Architecture

```text
SiteShrimp PWA
    │  (LOG zero-tap / AUTO-TAG / AI Pin)
    ▼
api.siteshrimp.org   (PocketBase, GCP)
    │
    │  POST /api/ai/analyze  — server-side proxy
    │  (per-user daily cap, hides Ollama URL from client bundle)
    ▼
ai.siteshrimp.org   (Oracle Ampere A1 Always Free, no GPU)
    ├── Ollama daemon  (port 11434)
    │    └── moondream  (1.9 B, INT4)         ◄── Phase 1, the fallback model
    │    └── (future) ft-moondream            ◄── Phase 4, LoRA fine-tuned weights
    ├── pgvector (Postgres)                   ◄── Phase 2/3, RAG retrieval store
    └── Embedder service (CPU OpenCLIP)       ◄── Phase 2/3
```

Key properties of this design:

- **Oracle Always Free** carries everything that needs to live under our control: model weights, RAG store, embedder. None of these need a GPU at Moondream 2's size.
- **Self-hosted end-to-end**. No third-party API in the data path. SiteShrimp owns the weights and the inference.
- **App-side change is small**: a new `POST /api/ai/analyze` endpoint in `pb_hooks/main.pb.js` that forwards to the Oracle Ollama URL via the existing `analyzeWithOllamaServer` helper (already at `pb_hooks/main.pb.js:540`). The client's `analyzePhoto` dispatcher falls through to this endpoint when no user-configured provider is set.
- **Existing provider paths untouched**. Users who bring their own Gemini / OpenAI / Groq key keep that flow exactly as today.

## Progressive path

1. **Now (this branch)**: model selected (Moondream 2). Architecture decided.
2. **Phase 1**: stand up Oracle Ampere VM, install Ollama, pull `moondream`. Add `/api/ai/analyze` proxy endpoint in `pb_hooks/main.pb.js`. Wire client dispatcher + Settings UI banner. End state: a fresh-install user can LOG defects with AI prefill without ever opening Settings.
3. **Phase 2**: add pgvector + embedder on the same Oracle VM. Wire the proxy to embed each incoming photo and store it. Initially retrieval is off — we're just building the index.
4. **Phase 3**: turn on retrieval once a meaningful number of human-verified entries exist per project. Few-shot prompt augmentation kicks in.
5. **Phase 4**: LoRA fine-tune Moondream 2 on the accumulated CONQUAS dataset (or graduate to Qwen2.5-VL-7B fine-tune if quality demands and we move to a paid GPU instance). Swap the Ollama model file; app endpoints unchanged.

Each phase keeps the same app code path — only what runs on the Oracle VM changes.

## Risks and tradeoffs

- **Moondream 2 quality ceiling**. 1.9 B parameters is smaller than flagship models. Defect-type recognition is workable; CONQUAS tier classification needs human confirmation (your `[AI HITL]` rule). The fine-tune in Phase 4 is the durable answer; for Phase 1 the human-in-the-loop is the safety net.
- **Single-VM serialization**. One Oracle Ampere VM serves all default-tier traffic. Aggregate load = queue. Mitigation: per-user daily call cap at the proxy, and a graceful pointer to *"Add your own AI key for higher quality and no daily limits."*
- **Oracle Always Free reclamation**. Idle VMs can be reclaimed. Runbook will include a keep-alive cron.
- **Cold start**. First request after VM idle is slower (Ollama loads the model into memory). Runbook will pre-warm at boot via a `systemd` `ExecStartPost`.

## Status

- [x] Architecture decided: Moondream 2 on Ollama, self-hosted on Oracle Ampere Free
- [x] Branch open: `feat/oracle-vision-ai`
- [ ] Phase 1 implementation (VM setup runbook + `/api/ai/analyze` proxy + client dispatcher + Settings UI)
- [ ] Phase 2 enablement (pgvector + embedder on same VM)
- [ ] Phase 3 enablement (retrieval on, once data exists)
- [ ] Phase 4 enablement (LoRA fine-tune)

The next decision is whether to ship Phase 1 immediately or to stand up the Oracle proxy first.
