# PrasuNova Showroom — Multi-Tenant AI Tile Visualizer

A generic, multi-tenant digital showroom platform. Any tile or granite store signs up, uploads their catalog, and instantly gets a branded visualizer at:

```
https://showroom.prasunova.in/s/?shop=<their-slug>
```

No code required. No per-client deployments. **One codebase, infinite showrooms.**

---

## URL Structure

| URL | Purpose |
|-----|---------|
| `showroom.prasunova.in/` | Marketing landing page |
| `showroom.prasunova.in/admin/` | Shop owner login & tile management |
| `showroom.prasunova.in/admin/register.html` | New showroom registration |
| `showroom.prasunova.in/s/?shop=<slug>` | The live tile visualizer for any shop |

The `/s/` path is intentional — it prevents direct browsing and keeps each shop's link clean and direct-access-only.

---

## How It Works

| Mode | How | AI | Wait |
|------|-----|----|------|
| Catalog rooms | Admin pushes photo → Actions runs SAM 3 → masks stored in R2 | SAM 3 (HF Transformers) | 15–30 min one-time |
| User uploads | User uploads → Backend dispatches Actions → SAM 3 | SAM 3 (HF Transformers) | 8–15 min one-time |
| Rendering | Canvas applies tile texture over mask region | None | < 100ms |

---

## Repository Structure

```
docs/                           ← Deployed to GitHub Pages (showroom.prasunova.in)
  index.html                    ← Marketing landing page (root /)
  styles.css                    ← Shared design system (Outfit, gold/dark theme)
  config.js                     ← API_BASE, TURNSTILE_SITE_KEY
  s/
    index.html                  ← The tile visualizer app (/s/?shop=<slug>)
    app.js                      ← Canvas renderer, room gallery, tile sidebar
    upload.js                   ← User room upload + polling flow
  admin/
    index.html                  ← Shop owner login + tile management dashboard
    register.html               ← New showroom registration (OTP flow)
    forgot-password.html        ← Password reset (OTP flow)
    app.js                      ← Admin dashboard logic
    register.js                 ← Registration flow JS
    forgot-password.js          ← Reset flow JS
```

---

## Adding a New Showroom (Admin)

1. The shop owner visits `showroom.prasunova.in/admin/register.html`
2. Enters their shop name, unique slug, and email
3. Verifies OTP → sets password → account created
4. Uploads tile photos via the admin dashboard
5. Shares their link: `showroom.prasunova.in/s/?shop=<slug>`

No manual steps required from the platform side.

---

## Tile Image Spec

All tile texture images must be: **512×512px · 72dpi · JPEG · < 100KB**

---

## Setup (Infrastructure — Do Once)

### 1. GitHub Pages
- Settings → Pages → Source: Deploy from branch → Branch: `main` → Folder: `/docs`

### 2. HuggingFace Access (for SAM 3)
- Visit https://huggingface.co/facebook/sam3 and request access
- Generate a read token at https://huggingface.co/settings/tokens
- Add as GitHub Actions secret `HF_TOKEN` in the `showroom-data` repo

### 3. Update `docs/config.js`
```js
export const API_BASE           = 'https://your-backend.onrender.com';
export const TURNSTILE_SITE_KEY = 'your-cloudflare-site-key';
export const SITE_TITLE         = 'Digital Showroom — PrasuNova';
```

---

## Cost

**$0/month.** GitHub Pages (hosting) + GitHub Actions public repo (AI compute) + Cloudflare R2 + Workers free tiers cover most showrooms completely.
