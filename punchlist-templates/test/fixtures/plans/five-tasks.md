### Task 1: sampler rename

**Files:**
- Create: `lib/sampler.js`
- Create: `test/sampler.test.js`

**Interfaces:**
- Produces: `sample(x) → number`

### Task 2: store on the sampler

**Files:**
- Modify: `lib/store.js`

**Interfaces:**
- Consumes: `sample` from Task 1.

### Task 3: resolver

**Files:**
- Create: `lib/resolver.js`
- Test: `test/resolver.test.js`

**Interfaces:**
- Produces: `resolve(q) → object`

### Task 4: resolver metrics

**Files:**
- Modify: `lib/resolver.js`

**Interfaces:**
- Produces: `metrics() → object`

### Task 5: docs pass

**Interfaces:**
- Produces: prose only.

### Task 6: prose-only forward mention (R1 fixture)

**Files:**
- Create: `lib/report.js`

**Interfaces:**
- Produces: `report() → string` — mirrors the shape Task 4 introduced, for consistency. This sentence names Task 4 but is a `Produces:` bullet, not a `Consumes:` bullet, so it must create no edge.

### Task 7: a Consumes-shaped line past the boundary (R2 fixture)

**Files:**
- Create: `lib/late.js`

**Interfaces:**
- Produces: `late() → string`

- [ ] **Step 1: note.** Consumes: resolve from Task 1. (This line is inside a Step, after the Interfaces boundary — R2 says it must never be read as a dependency, even though it says "Consumes:" and names a task.)
