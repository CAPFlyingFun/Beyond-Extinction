# ChatGPT Review: Dynamic Fauna and Ecosystem Roadmap

> Working design notes for Claude Code and future contributors.
>
> Reviewed against `main` at commit `628b4788f94ea9fced7d26b820e1cd02e60daeaa`.
>
> Scope: the TypeScript / Three.js web build, especially
> `artifacts/beyond-extinction/src/engine/SeaCreatures.ts` and its integration in
> `ChapterOnePlaceholderScene.ts`.

## Why this document exists

The project already has a real creature AI foundation. It does **not** need an
LLM to decide every footstep, bite, or swim turn. The next step is to turn the
current player-centered fauna controller into a reusable local ecosystem that
can support:

- predators hunting prey,
- herbivores feeding and migrating,
- packs, herds, territories, nests, and young,
- creatures reacting to one another when the player is absent,
- distant regions advancing cheaply without rendering every dinosaur,
- optional high-level world events later.

The correct architecture is:

1. deterministic local game AI for moment-to-moment behavior,
2. a low-frequency simulation for distant populations,
3. an optional high-level world director for rare events.

Do **not** send one API request per creature or place an OpenAI API key in the
browser client.

---

## Current system: what is already good

The current `SeaCreatures` implementation has several solid pieces worth
preserving:

- Separate sea and amphibious finite-state machines.
- Low-frequency thinking (`SEA_THINK_DT` and `LAND_THINK_DT`) separated from
  per-frame movement.
- Species-authored speeds, ranges, damage, turn rates, depth bands, and
  temperaments.
- Player stance affecting detection distance.
- FOV checks for land creatures.
- Attack telegraph, strike timing, cooldown, leash, and chase-stall handling.
- Sea patrol, investigate, lunge, orbit, peel-away, water-column correction,
  and beaching prevention.
- Passive taming, tracking, save/restore, and tamed follow/stay/wander orders.
- Deterministic random generation.
- Streaming around a focus point so the web build does not simulate the entire
  island at full fidelity.
- Debug state labels, which are useful until animation states are visible.

This is a strong prototype. The goal is to extract and extend it, not throw it
away.

---

## Immediate correctness issues to fix first

These are higher priority than adding more species.

### 1. Restore prevents the normal population from filling

`update()` applies restored creatures before calling `populate()`. `populate()`
returns whenever `creatures.length > 0`.

Result: if a save restores one tracked or tamed creature, the world may contain
only that one creature instead of the configured population count.

**Required fix:** make population filling additive.

```ts
private populate(focus: THREE.Vector3): void {
  if (!this.ready) return;

  while (this.creatures.length < this.count) {
    const creature = this.build(this.pickSpecies());
    this.place(creature, focus, true);
    this.creatures.push(creature);
    this.root.add(creature.group);
  }
}
```

Also prevent duplicate restore application if restore is called more than once.

### 2. `neutral` currently behaves at least as aggressively as `aggressive`

In `thinkLand()`:

- aggressive attacks when the player is seen,
- neutral attacks when the player is seen **or** provoked.

That means neutral is not neutral. It has every aggressive trigger plus another
one.

**Recommended behavior:**

- `passive`: never initiates combat,
- `skittish`: flees when noticed or approached,
- `neutral`: warns when approached, attacks only inside personal space or after
  provocation,
- `territorial`: attacks inside territory,
- `aggressive`: hunts valid targets within perception range.

Add a `warn` or `threat-display` state before neutral combat. A crocodile can
turn, hiss, raise its head, or open its jaws before committing.

### 3. Feed cooldown countdown is mathematically inaccurate

After a feed completes, `agitated` and `baskCd` run at the same time. The UI
currently adds them:

```ts
feedWindow + agitated + baskCd
```

Because the latter two overlap, the displayed countdown can be too long.
Additionally, basking is selected probabilistically, so “ready in N seconds” is
not actually guaranteed.

Choose one of these solutions:

- use `Math.max(agitated, baskCd)` and label it “calms in”, or
- schedule a deterministic `nextBaskAt` timestamp and make the countdown exact.

The deterministic scheduler is better for player trust and testability.

### 4. The Aggressive toggle is currently UI-only

`tamed.aggressive` is saved and displayed but does not affect target selection
or combat. Until creature-to-creature targeting exists, either:

- hide or disable the toggle with “Coming later”, or
- implement a minimal defend-player behavior before presenting it as active.

Do not let a control imply behavior that does not exist.

### 5. Restored creatures should be validated

Before restoring an entry:

- validate finite coordinates,
- clamp or relocate invalid positions,
- clamp `tamePct` to zero through one hundred,
- verify the species exists,
- reject malformed entries,
- consider migrating save versions instead of silently trusting arbitrary
  `Record<string, unknown>` data.

Use a small manual validator or Zod if already justified elsewhere. Do not add a
large dependency solely for this one structure.

### 6. The current docs are stale

`README.md` correctly describes TypeScript and the current web build, while
`replit.md` still says vanilla JavaScript and describes `AudioManager` as a
stub. Update architectural docs after the fauna refactor so Claude does not
work from contradictory maps.

---

## Structural problems that will block a full ecosystem

### One class owns too many responsibilities

`SeaCreatures.ts` now handles:

- species configuration,
- model loading and fitting,
- spawning and recycling,
- save/restore,
- ray selection,
- labels,
- sea behavior,
- land behavior,
- movement,
- combat,
- taming,
- tamed orders,
- random generation.

It has outgrown its name and its boundaries. Before adding dozens of species,
refactor it into a `FaunaSystem` with focused modules.

### Targeting only understands the player

Every brain currently receives an optional `FaunaPlayer`. A real ecosystem
needs a generic target model so a predator can evaluate players, wild animals,
tamed animals, corpses, nests, and food sources through the same interface.

### Rendered creature and simulated creature are the same object

The present system recycles rendered animals around the player. This is good
for ambience but cannot represent a persistent island population.

Separate:

- **FaunaEntity:** durable simulation record,
- **FaunaAgent:** active high-fidelity brain,
- **FaunaView:** Three.js model, animation mixer, label, and effects.

A creature should be able to exist as data without having a loaded GLB.

### Numeric shared states are fragile

Sea and land states share a numeric `Creature.state`. Replace this with a
discriminated union or separate typed state fields. String states are easier to
debug and save safely.

```ts
type SeaState = "cruise" | "investigate" | "lunge" | "flee";
type LandState =
  | "idle"
  | "wander"
  | "feed"
  | "drink"
  | "warn"
  | "chase"
  | "attack"
  | "flee"
  | "bask"
  | "sleep";
```

### Movement has no navigation or obstacle avoidance

Land creatures move directly toward destinations. Once trees, rocks, cliffs,
structures, and many animals exist, they will walk through obstacles, stack,
or climb impossible slopes.

The web build does not need a giant navmesh immediately. Start with:

- terrain slope rejection,
- forward terrain probes,
- simple steering around blocked samples,
- separation from nearby creatures,
- habitat masks,
- bounded retries with a safe fallback.

A grid or navmesh can be added later if the island becomes dense.

---

## Recommended file layout

Refactor in small behavior-preserving steps.

```text
src/engine/fauna/
  FaunaSystem.ts              # public facade and update orchestration
  FaunaTypes.ts               # entity, state, target, event, save types
  SpeciesCatalog.ts           # immutable species definitions
  FaunaEntityStore.ts         # durable entity records and IDs
  FaunaSpawner.ts             # biome/population spawning rules
  FaunaStreaming.ts           # active bubble and view activation
  FaunaPersistence.ts         # versioned save/restore and migration
  FaunaSpatialIndex.ts        # nearby queries
  FaunaPerception.ts          # sight, hearing, scent, LOS, target candidates
  FaunaCombat.ts              # damage, death, cooldowns, hit events
  FaunaNeeds.ts               # hunger, thirst, stamina, sleep, fear
  FaunaGroups.ts              # herd, pack, parent/young, leader rules
  FaunaDebug.ts               # labels, inspector, event log
  brains/
    SeaBrain.ts
    LandBrain.ts
    TamedBrain.ts
    DistantBrain.ts
  steering/
    SeaSteering.ts
    LandSteering.ts
    Avoidance.ts
```

Do not create every file at once. First extract types and species config, then
move one behavior domain per commit.

---

## Core data model

### Durable entity

```ts
export interface FaunaEntity {
  id: string;
  speciesId: SpeciesId;
  position: Vec3Data;
  heading: Vec3Data;
  home: Vec3Data;
  regionId: RegionId;

  age: number;
  sex: "female" | "male";
  health: number;
  stamina: number;
  hunger: number;
  thirst: number;
  fear: number;

  state: FaunaState;
  targetId?: string;
  groupId?: string;
  ownerId?: string;

  tame: {
    progress: number;
    isTamed: boolean;
    order: "follow" | "stay" | "wander";
    stance: "passive" | "defensive" | "aggressive";
  };

  memory: {
    lastThreatId?: string;
    lastThreatAt?: number;
    lastFoodPosition?: Vec3Data;
    lastWaterPosition?: Vec3Data;
  };
}
```

Use serializable plain data. Keep Three.js objects out of the entity model.

### Runtime agent

```ts
export interface FaunaAgent {
  entityId: string;
  thinkAccumulator: number;
  currentIntent: FaunaIntent;
  perception: PerceptionSnapshot;
}
```

### View

```ts
export interface FaunaView {
  entityId: string;
  group: THREE.Group;
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer | null;
}
```

This separation makes streaming, saves, tests, and distant simulation much
simpler.

---

## Generic perception and targeting

Create a generic candidate type instead of passing only the player.

```ts
export interface PerceptionTarget {
  id: string;
  kind: "player" | "wild-creature" | "tamed-creature" | "corpse" | "food" | "nest";
  speciesId?: SpeciesId;
  position: THREE.Vector3;
  velocity?: THREE.Vector3;
  alive: boolean;
  faction: "player" | "wild" | "tamed" | "environment";
  bodyMassKg?: number;
  threatScore?: number;
  foodValue?: number;
}
```

A perception pass should gather candidates through a spatial index, then filter
by:

- distance,
- FOV,
- line of sight,
- hearing radius,
- scent radius if used,
- habitat compatibility,
- predator/prey rules,
- faction and tame stance,
- memory of recent threats.

Do not run an all-versus-all scan.

---

## Utility selection above the existing FSMs

Keep FSMs for executing an action, but use utility scoring to choose the next
intent. This avoids a giant maze of special-case transitions.

Example intent scores:

```ts
const eatScore = hunger01 * foodAvailability * safety;
const drinkScore = thirst01 * waterAvailability * safety;
const huntScore = hunger01 * aggression * preySuitability * confidence;
const fleeScore = danger * injuryFactor * targetPowerRatio;
const restScore = fatigue01 * safety;
const defendScore = groupThreat * loyalty;
const mateScore = matingDrive * seasonFactor * safety;
```

Selection rules:

1. Hard overrides first: dead, scripted, stunned, trapped.
2. Emergency needs: flee, surface for air, escape invalid terrain.
3. Combat and defense.
4. Survival needs.
5. Social and reproduction behavior.
6. Idle, roam, bask, play, investigate.

Add hysteresis so creatures do not flip intentions every think tick.

```ts
if (newScore > currentScore + SWITCH_MARGIN || currentIntentExpired) {
  switchIntent(nextIntent);
}
```

---

## Predator and prey MVP

The first ecosystem milestone should be deliberately small.

### Species roles

Use the current five species plus one simple herbivore or dodo agent:

- Ichthyosaurus: curious, social, flees large predators.
- Megalodon: hunts smaller sea animals and vulnerable swimmers.
- Mosasaurus: apex sea predator; may contest sharks.
- Sarcosuchus: neutral territorial ambush predator.
- Deinosuchus: aggressive ambush predator.
- Dodo or small herbivore: forage, flee, and become prey.

### Minimum interactions

- Predators acquire valid prey when hungry.
- Prey detect predators and flee.
- Predators abandon impossible or costly chases.
- A successful attack applies damage through one combat event path.
- Death creates a corpse/food source for a limited time.
- Predators eat, reduce hunger, then lose interest.
- Tamed passive animals ignore combat.
- Tamed defensive animals retaliate when owner or self is attacked.
- Tamed aggressive animals may attack hostile targets inside a command radius.

### Target suitability

```ts
suitability =
  edibleRelationship *
  sizeConfidence *
  distanceFactor *
  healthVulnerability *
  habitatReachability *
  hungerPressure;
```

A predator should not attack everything merely because it is nearby.

---

## Groups, herds, and packs

Do not give every herd member a completely independent destination.

Create a group record:

```ts
interface FaunaGroup {
  id: string;
  kind: "herd" | "pack" | "family";
  leaderId: string;
  memberIds: string[];
  homeRegionId: RegionId;
  destination?: Vec3Data;
  alertLevel: number;
}
```

Group rules:

- The leader chooses migration and broad movement.
- Members use formation, cohesion, and separation steering.
- One member detecting danger raises the group alert.
- Packs choose a shared target but individual approach slots.
- Parents defend young more strongly.
- Group updates can run less often than individual movement.

This creates believable population behavior without multiplying decision cost.

---

## Active bubble and distant simulation

A whole island cannot run every dinosaur at full Three.js fidelity.

### Three simulation tiers

#### Tier A: visible agents

- Inside roughly 120 to 180 metres.
- Full model, animation, movement, perception, combat.
- Think about five times per second.
- Movement each frame.

#### Tier B: nearby background agents

- Roughly 180 to 500 metres.
- No expensive animation or detailed raycasts.
- Update one to two times per second.
- Simplified movement and encounters.

#### Tier C: distant regional simulation

- Outside the active area.
- No Three.js model.
- Update every five to thirty seconds or when game time advances.
- Store region, population, hunger pressure, migration progress, injuries, births,
  and deaths statistically.

When a player approaches, materialize entities from the region state into valid
positions. When they leave, dematerialize views but retain entity data.

### Region model

Divide the island into authored ecological regions or a coarse grid. Each region
can store:

```ts
interface RegionEcology {
  id: RegionId;
  biome: BiomeId;
  food: number;
  water: number;
  shelter: number;
  populations: Partial<Record<SpeciesId, number>>;
  danger: number;
  recentEvents: EcologyEvent[];
}
```

This is the core of “the world keeps living when the player is elsewhere.”

---

## Spatial index

Before increasing the active population, add a simple uniform spatial hash.

```ts
class FaunaSpatialIndex {
  insert(id: string, position: THREE.Vector3): void;
  move(id: string, oldPosition: THREE.Vector3, newPosition: THREE.Vector3): void;
  remove(id: string): void;
  queryRadius(position: THREE.Vector3, radius: number): string[];
}
```

A cell size around the common perception range is sufficient initially.

Use it for:

- perception candidates,
- separation steering,
- attack queries,
- interaction ray candidate narrowing,
- nearby food and water searches.

---

## Combat event pipeline

Avoid direct callbacks that only understand player damage.

```ts
type FaunaEvent =
  | { type: "attack-started"; attackerId: string; targetId: string }
  | { type: "damage"; sourceId: string; targetId: string; amount: number }
  | { type: "death"; entityId: string; killerId?: string }
  | { type: "tamed"; entityId: string; ownerId: string }
  | { type: "state-changed"; entityId: string; from: FaunaState; to: FaunaState };
```

The scene can subscribe to player-facing consequences, while the fauna system
uses the same events for wild creatures.

Benefits:

- one damage system,
- easier debugging,
- easier sound and animation hooks,
- deterministic tests,
- future quest integration.

---

## Species data should become data, not branches

Move tuning values out of the controller. A species definition should include:

- habitat and biome preferences,
- body size and mass,
- diet and prey relationships,
- temperament,
- senses,
- locomotion,
- combat attacks,
- group behavior,
- daily activity pattern,
- taming method,
- animation mapping,
- spawn constraints.

Example:

```ts
interface SpeciesDefinition {
  id: SpeciesId;
  displayName: string;
  habitat: "land" | "amphibious" | "sea" | "air";
  diet: "herbivore" | "carnivore" | "omnivore";
  prey: Partial<Record<SpeciesId, number>>;
  predators: Partial<Record<SpeciesId, number>>;
  temperament: Temperament;
  senses: SenseConfig;
  movement: MovementConfig;
  combat: AttackConfig[];
  needs: NeedsConfig;
  social: SocialConfig;
  spawn: SpawnConfig;
  model: ModelConfig;
}
```

Validate definitions once at startup and fail clearly in development builds.

---

## Performance rules for the browser/PWA build

This is an iOS Safari game, so design for modest CPU and memory budgets.

- Start with 20 to 30 active agents, not hundreds.
- Keep decision ticks around five hertz.
- Stagger think ticks across frames.
- Use spatial queries instead of all-pairs loops.
- Reuse temporary vectors in hot loops.
- Avoid `clone()` and `new THREE.Vector3()` repeatedly per creature per frame.
- Pool views and effects where practical.
- Keep debug labels off in production.
- Limit shadows on creatures based on distance.
- Prefer one shared geometry/material per species where safe.
- Profile real iPhone Safari, not only desktop Chrome.
- Add counters for active, background, distant, sleeping, and rendered entities.

Suggested development overlay:

```text
Fauna: 24 active / 61 nearby / 438 distant
Think: 1.8 ms
Movement: 1.1 ms
Perception queries: 92/s
Views: 27
```

---

## Testing strategy

The current package has typecheck and build gates but no fauna unit-test gate.
Add small deterministic tests for pure logic before expanding the AI.

Priority tests:

1. Restoring one creature still fills the remaining population.
2. Neutral creatures do not attack merely because a distant player is visible.
3. Aggressive creatures acquire valid targets.
4. Feed cooldown never promises a time earlier or later than the actual state
   transition.
5. A tamed passive creature never initiates combat.
6. A tamed defensive creature retaliates only after a valid attack event.
7. Predators prefer valid prey over allies and non-food targets.
8. Prey flee stronger predators.
9. Chase gives up after distance, leash, or stall thresholds.
10. Save migration handles missing fields from older snapshots.
11. A fixed seed produces repeatable decisions.
12. Distant simulation conserves valid population counts and never produces
    negative food or animals.

Keep Three.js scene tests minimal. Most decision logic should be pure functions
that accept plain snapshots.

---

## Implementation phases

### Phase 0: stabilize the existing prototype

- Fix restore population filling.
- Fix neutral temperament semantics.
- Correct or rename feed cooldown display.
- Hide or implement the tamed aggression toggle.
- Validate save entries.
- Add initial deterministic tests.
- Update stale docs.

**Acceptance:** existing sea/croc behavior still works, saves restore correctly,
and typecheck/build/tests pass.

### Phase 1: behavior-preserving refactor

- Rename the facade from `SeaCreatures` to `FaunaSystem`.
- Extract types and species catalog.
- Separate model/view management from entity state.
- Replace numeric states with typed states.
- Add an event pipeline.
- Preserve current player behavior exactly.

**Acceptance:** no intentional gameplay change; smaller modules; clean build.

### Phase 2: creature-to-creature interaction MVP

- Add generic perception targets.
- Add spatial hash.
- Add one prey species behavior.
- Allow sea predators and crocs to target valid prey.
- Add flee, damage, death, corpse, and eating loops.
- Make tamed stance functional.

**Acceptance:** the player can watch a predator-prey encounter happen without
participating.

### Phase 3: needs and social behavior

- Hunger, thirst, stamina, sleep, fear.
- Water and food locations.
- Herds/packs and group alerts.
- Territories and warning displays.
- Day/night activity differences.

**Acceptance:** creatures spend more time living than attacking.

### Phase 4: whole-island persistence

- Entity store independent of views.
- Region ecology model.
- Active/nearby/distant simulation tiers.
- Materialize and dematerialize agents around the player.
- Versioned world save.

**Acceptance:** leaving and returning to a region produces continuity rather
than a freshly randomized population.

### Phase 5: rare world events and optional AI director

Only after the local ecosystem is stable:

- migration waves,
- nesting season,
- drought,
- disease,
- territorial conflict,
- unusual alpha or albino spawn,
- story-aware fauna events.

An external language model may suggest **rare high-level events**, but it must
not control movement or combat. The browser client must never contain a secret
API key. Any API integration requires a protected server endpoint, schema
validation, rate limits, fallback behavior, and an offline-safe default.

Example allowed output:

```json
{
  "events": [
    {
      "type": "migrate-group",
      "speciesId": "parasaurolophus",
      "fromRegion": "north-valley",
      "toRegion": "river-plains",
      "count": 12
    }
  ]
}
```

The game validates and translates that into local simulation commands.

---

## First recommended Claude Code task

Implement **Phase 0 only** in a focused PR.

Suggested sequence:

1. Add deterministic fauna tests and a test script.
2. Fix additive population filling after restore.
3. Introduce a true neutral personal-space threshold or warning state.
4. Replace the inaccurate feed countdown with deterministic scheduling or a
   truthful “calming” status.
5. Disable the tamed Aggressive toggle until it performs an action.
6. Validate restore data.
7. Run:

```bash
pnpm --filter @workspace/beyond-extinction typecheck
pnpm --filter @workspace/beyond-extinction build:github
```

8. Record behavior changes in the PR description.

Do not combine Phase 0 with the large folder refactor. Stabilize first, then
move the walls.

---

## Rules for Claude Code while implementing this roadmap

- Preserve story canon and cinematic timing.
- Do not rewrite unrelated HUD, audio, arrival, or progression code.
- Keep each commit focused and reversible.
- Run typecheck and the GitHub Pages build after meaningful changes.
- Prefer typed pure functions for behavior decisions.
- Avoid introducing a backend or OpenAI dependency during the local AI phases.
- Never expose an API key in client code, Vite variables, source maps, or the
  repository.
- Keep deterministic seeds available for debugging.
- Add visible debug instrumentation before guessing at behavior.
- Do not increase population counts until profiling supports it.
- Treat `replit.md` as potentially stale; trust the current source and README.
- Update this document when a phase is completed or the architecture changes.

---

## Definition of the desired result

The successful system should create moments such as:

- a small herd changes direction because one member spots a predator,
- a hungry crocodile waits near a watering route instead of charging forever,
- a predator abandons prey that is too fast or too dangerous,
- a tamed animal defends Jack only when ordered to do so,
- creatures continue migrating and competing while the player explores another
  region,
- returning later reveals consequences without requiring every dinosaur to have
  been rendered the entire time.

That is the target: a living island driven by efficient game AI, not a cloud
model puppeteering every tail flick.
