import { test } from "node:test";
import assert from "node:assert/strict";
import { TerrainEdit, CELL_U } from "./TerrainEdit.ts";

test("empty layer is a pure no-op (deltaAt = 0 everywhere)", () => {
  TerrainEdit.clear();
  assert.equal(TerrainEdit.deltaAt(0, 0), 0);
  assert.equal(TerrainEdit.deltaAt(1234.5, -678.9), 0);
  assert.equal(TerrainEdit.hasEdits, false);
});

test("setCell + deltaAt samples the exact cell, bilinear between cells", () => {
  TerrainEdit.clear();
  const { i, j } = TerrainEdit.cellOf(100, 200);
  TerrainEdit.setCell(i, j, 5);
  const c = TerrainEdit.cellCentre(i, j);
  // At the cell centre we read exactly the delta.
  assert.equal(Math.round(TerrainEdit.deltaAt(c.x, c.z) * 100) / 100, 5);
  // Half a cell toward an empty neighbour → ~half (bilinear falloff).
  const mid = TerrainEdit.deltaAt(c.x + CELL_U / 2, c.z);
  assert.ok(mid > 2 && mid < 3, `expected ~2.5, got ${mid}`);
  // A full cell away (empty neighbour) → 0.
  assert.equal(TerrainEdit.deltaAt(c.x + CELL_U, c.z), 0);
});

test("setCell to 0 keeps the field sparse", () => {
  TerrainEdit.clear();
  TerrainEdit.setCell(3, 4, 2);
  assert.equal(TerrainEdit.cellCount, 1);
  TerrainEdit.setCell(3, 4, 0);
  assert.equal(TerrainEdit.cellCount, 0);
  assert.equal(TerrainEdit.hasEdits, false);
});

test("serialize round-trips through loadFrom", () => {
  TerrainEdit.clear();
  TerrainEdit.setCell(10, -20, 3.5);
  TerrainEdit.setCell(-5, 5, -1.25);
  const json = TerrainEdit.serialize();
  TerrainEdit.clear();
  assert.equal(TerrainEdit.cellCount, 0);
  TerrainEdit.loadFrom(json);
  assert.equal(TerrainEdit.getCell(10, -20), 3.5);
  assert.equal(TerrainEdit.getCell(-5, 5), -1.25);
  assert.equal(TerrainEdit.cellCount, 2);
  TerrainEdit.clear();
});
