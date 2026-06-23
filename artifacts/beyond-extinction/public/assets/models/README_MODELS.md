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
