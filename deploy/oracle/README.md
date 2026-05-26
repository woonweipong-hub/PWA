# Oracle Vision AI — Architecture Decision

This branch (`feat/oracle-vision-ai`) builds the zero-setup AI path for SiteShrimp. The end-user no longer has to configure a provider before logging defects; SiteShrimp ships with a default that works out of the box, free-of-charge, and gets smarter over time.

## Hard constraints (the four asks)

1. **Free-of-charge** for SiteShrimp and end users. No expiring credits, no card-on-file.
2. **Speed**. Sub-second to a few seconds per photo. No CPU inference of large models.
3. **Trainable**. The chosen weights must support LoRA / QLoRA fine-tuning so that, once a CONQUAS-verified dataset exists, the model becomes project-specific.
4. **Workable for CONQUAS / A&I visual checks**. Strong JSON output adherence, decent defect-class recognition, OCR on unit signage and grid IDs.

## Selected model — **Llama 3.2 11B Vision Instruct**

- **License**: Llama 3 community license. Commercial use permitted at SiteShrimp's scale.
- **Weights**: open, downloadable, redistributable per license terms.
- **Inference today**: served free on Groq's LPU (sub-second). OpenRouter has it as a free alternative with looser rate limits.
- **Fine-tuning ecosystem**: Unsloth, Axolotl, LLaMA-Factory — all mature, all open source. LoRA training fits on a single 24 GB consumer GPU.
- **JSON output**: well-behaved with strict prompt formatting; works with the existing `AI_SERVER_PROMPT` shape in `pb_hooks/main.pb.js`.

### Models considered and rejected

- **Qwen2.5-VL-7B** — better license (Apache 2.0) and slightly stronger on document tasks, but not reliably available on a fast free provider today. Loses on the *speed* constraint.
- **Qwen2.5-VL-3B (CPU-quantised on Oracle Ampere Always Free)** — sustainable cost-wise, but 8-18 s per photo on CPU is unacceptable friction. Rejected by user explicitly.
- **Gemini 2.5 Flash free tier** — fastest and zero-setup, but you cannot own the weights or fine-tune. Fails the *trainable* constraint.
- **Phi-3.5-Vision** — small enough for CPU, but quality on defect recognition lags Llama 3.2 11B materially.

## Architecture

```
SiteShrimp PWA
    │
    ▼
ai.siteshrimp.org   (Oracle Always Free VM, no GPU needed)
    ├── Vector store  (pgvector on Postgres, per-project scoped)
    ├── Embedder      (CPU OpenCLIP or SigLIP)
    └── RAG proxy     (Node service)
            │
            │ embeds photo, retrieves K verified neighbours,
            │ formats few-shot prompt
            ▼
    Groq API   (Llama 3.2 11B Vision Instruct, free tier)
            │
            └── returns structured JSON → back through RAG proxy → app
```

Key properties of this design:

- **Oracle Always Free** carries no compute that needs a GPU. pgvector + a CPU embedder fits the Ampere A1 (4 OCPU / 24 GB) tier.
- **Groq** carries the actual vision inference, free of charge, fast.
- **App-side change is small**: a `default_provider = "siteshrimp-default"` block in `pb_hooks/main.pb.js` that calls the Oracle endpoint. The existing OpenAI / Gemini / Ollama / Groq provider paths stay intact for power users who bring their own key.

## Progressive path

1. **Now (this branch)**: model selected, branch open. Decide next step with user before writing code.
2. **Phase 1**: ship the `default_provider` wiring + Settings UI change so the no-key user is no longer blocked.
3. **Phase 2**: stand up the Oracle VM with pgvector + RAG proxy. Initially the proxy is a thin forwarder to Groq with no retrieval (no data to retrieve yet).
4. **Phase 3**: turn on retrieval once a meaningful number of human-verified entries exist per project. Few-shot prompt augmentation kicks in.
5. **Phase 4**: LoRA fine-tune Llama 3.2 11B Vision on the accumulated CONQUAS dataset. Self-host the fine-tuned model on a paid Oracle GPU instance only if Groq volume becomes a constraint.

Each phase keeps the same app code path — only the Oracle endpoint behaviour changes.

## Risks and tradeoffs

- **Groq free tier rate limits**. Aggregate user load can saturate. Mitigation: per-user rate limiting at the Oracle proxy, and a graceful fallback prompt to *"Add your own AI key for higher quality and no shared limits."*
- **Llama 3.2 community license**. Permissive for SiteShrimp's current scale; revisit if the deployment grows past the license's named thresholds.
- **Quality vs Gemini 2.5 Pro**. Llama 3.2 11B Vision is good, not best-in-class. Power users (CONQUAS Officer sign-off flow) should still have the option to bring their own Gemini / OpenAI key — and they do.
- **Oracle Always Free reclamation**. Idle VMs can be reclaimed. The proxy is constantly serving so this is unlikely, but the runbook will include a keep-alive cron.

## Status

- [x] Architecture decided: Llama 3.2 11B Vision via Groq + Oracle RAG layer
- [x] Branch open: `feat/oracle-vision-ai`
- [ ] Phase 1 implementation (default provider wiring)
- [ ] Phase 2 implementation (Oracle VM runbook + RAG proxy)
- [ ] Phase 3 enablement (retrieval on, once data exists)
- [ ] Phase 4 enablement (LoRA fine-tune)

The next decision is whether to ship Phase 1 immediately or to stand up the Oracle proxy first.
