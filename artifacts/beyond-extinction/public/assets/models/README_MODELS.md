# Beyond Extinction Model Folder

Place character and dinosaur GLB files here when they are ready.

Expected first character paths:

public/assets/models/Jack.glb
public/assets/models/Sarah.glb

The engine already tries to load these automatically. If a model is missing or fails to load, it uses a visible placeholder and logs the error in the browser console.

Mobile target notes:

- Aim for hero character GLBs around 5 to 10 MB when possible.
- Prefer compressed textures and 1K to 2K texture maps for early testing.
- High resolution embedded textures are usually the biggest reason a GLB gets large.
- Animated models can be swapped in later without changing scene logic.

## Compressing a new model

Jack.glb and Sarah.glb are compressed with
[`gltf-transform`](https://gltf-transform.dev/):

```
npx @gltf-transform/cli optimize input.glb output.glb \
  --compress draco \
  --texture-compress webp \
  --texture-size 2048 \
  --simplify false
```

- `--compress draco` shrinks geometry without changing vertex/triangle counts
  (quantization, not decimation).
- `--texture-compress webp --texture-size 2048` re-encodes textures and caps
  resolution; this is usually where the real size savings come from if the
  source model has 4K+ JPEG/PNG textures baked in.
- `--simplify false` keeps mesh detail untouched — drop this flag only if you
  are fine with the model losing actual polygons.

This took both character models from ~38 MB to ~1.4-1.5 MB with no visible
quality loss, well within the engine's Draco/Meshopt-aware GLTFLoader
(`src/engine/assets.ts`) and the `!*.glb` exceptions in the repo's
`.gitignore`.
