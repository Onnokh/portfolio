# The card, as a video

A [Remotion](https://www.remotion.dev) video of the onkie.dev card: a cursor opens it and closes it
again, and the video loops. It draws with the site's own renderer (`../src/DuoCard`), frame by frame,
with the site's content (`../src/profile.ts`) and the live contribution graph.

Install both packages first: the video takes the renderer's dependencies, such as vgpu, from the
site's `node_modules`.

```bash
npm install --prefix .. && npm install
```

- `npm run studio`: the video in Remotion Studio.
- `npm run render`: `out/onkie-card.mp4`, 1080 × 1080 at 60 fps. For X, post this one.
- `npm run gif`: `out/onkie-card.gif`, 648 × 648 at 30 fps.

What happens when, and the card's motion, are in `src/timeline.ts`; where the cursor goes is in
`src/Card.tsx`. The card draws with WebGPU, which Chrome only gives the GPU with ANGLE (see
`remotion.config.ts`), so render on a machine with a GPU.
