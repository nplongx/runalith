import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v147.json');
const runnerPath = path.join(root, 'benchmarks/adaptive-goal-graph/run-benchmark.mjs');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function run() {
  const result = spawnSync(process.execPath, [runnerPath, '--fixture', 'fixtures/recovery-verifier-v147.json'], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || `runner exited ${result.status}`);
  return JSON.parse(result.stdout);
}

function stableProjection(output) {
  return {
    config: output.config,
    summaries: output.summaries.map(({ meanRuntimeMs, ...summary }) => summary),
    records: output.records.map(({ runtimeMs, ...record }) => record)
  };
}

function createIsolatedRunnerWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-recovery-provenance-'));
  const files = [
    'package.json',
    'server/index.js',
    'server/index-v1.0.9-rc.7.js',
    'server/index-v1.0.9-rc.8.js',
    'tests/test-runalith-plugin.js',
    'tests/test-adaptive-goal-source-evidence.js',
    'tests/test-adaptive-goal-candidate-assessment-contract.mjs',
    'src/runtime/adaptive-goal-sandbox-executor.js',
    'benchmarks/adaptive-goal-graph/run-benchmark.mjs',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v18.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v19.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v20.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v21.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v22.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v23.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v25.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v27.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v28.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v29.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v30.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v31.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v32.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v34.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v35.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v36.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v37.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v38.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v39.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v43.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v44.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v45.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v48.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v49.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v50.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v51.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v52.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v53.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v54.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v55.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v56.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v57.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v58.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v59.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v60.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v61.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v62.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v63.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v64.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v65.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v66.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v72.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v73.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v76.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v77.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v78.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v79.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v80.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v81.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v83.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v84.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v85.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v86.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v87.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v88.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v89.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v90.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v91.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v92.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v93.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v94.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v99.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v100.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v101.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v102.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v103.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v104.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v105.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v106.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v107.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v108.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v109.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v110.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v111.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v112.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v113.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v114.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v115.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v116.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v117.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v118.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v119.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v120.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v121.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v122.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v123.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v124.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v125.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v126.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v127.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v128.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v129.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v130.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v131.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v132.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v133.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v134.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v135.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v136.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v137.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v144.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v145.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v146.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v147.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v125.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v17.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v15.json',
    'src/runtime/adaptive-goal-graph.js',
    'src/runtime/adaptive-goal-knowledge-store.js',
    'src/runtime/adaptive-goal-knowledge-verifier.js',
    'src/runtime/adaptive-goal-plan-adapter.js',
    'src/runtime/adaptive-goal-compatibility.js',
    'src/runtime/adaptive-goal-execution-graph-proposal.js',
    'src/runtime/adaptive-goal-reviewed-task-inputs.js',
    'src/runtime/adaptive-goal-execution-plan-candidate.js',
    'src/runtime/adaptive-goal-source-evidence.js',
    'tests/test-adaptive-goal-current-scope-producer-e2e.mjs',
    'tests/test-adaptive-goal-knowledge-verifier.mjs'
  ];
  for (const relative of new Set([...files, ...fixture.provenance.map(item => item.path)])) {
    const target = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  return workspace;
}

function isolatedFixturePath(workspace) {
  return path.join(workspace, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v147.json');
}

function runIsolated(workspace) {
  return spawnSync(process.execPath, [path.join(workspace, 'benchmarks/adaptive-goal-graph/run-benchmark.mjs'), '--fixture', 'fixtures/recovery-verifier-v147.json'], {
    cwd: workspace, encoding: 'utf8', timeout: 15000
  });
}

function fixtureBytes(workspace) {
  return JSON.parse(fs.readFileSync(isolatedFixturePath(workspace), 'utf8'));
}

function saveFixture(workspace, value) {
  fs.writeFileSync(isolatedFixturePath(workspace), `${JSON.stringify(value, null, 2)}\n`);
}

test('versioned provenance pins current sources and preserves the previous artifact identities', () => {
  const historicalV117 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v117.json'));
  assert.equal(createHash('sha256').update(historicalV117).digest('hex'), 'f0dc190bdff5d4e3a28d94fa2dd38cfc9c9e24acd71a2918e74807cf142f4b6c',
    'v117 remains byte-for-byte preserved as the RC.65 historical provenance fixture');
  const historicalV119 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v119.json'));
  assert.equal(createHash('sha256').update(historicalV119).digest('hex'), 'e6178d36cc9db520d5a4e7964c3f3c8e36e6533a072e39b153d4c95d2bd998c7',
    'v119 remains byte-for-byte preserved as the RC.67 historical source-pin fixture');
  const historicalV120 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v120.json'));
  assert.equal(createHash('sha256').update(historicalV120).digest('hex'), '365d3d3fc55a17e9c5216fd3637fe937f3ff18ba92adfd077423c768e86d9af8',
    'v120 remains byte-for-byte preserved as the first RC.69 provenance transition artifact');
  const historicalV121 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v121.json'));
  assert.equal(createHash('sha256').update(historicalV121).digest('hex'), '2c0fdf698b9b51434ba48a5eb2d6f4fdec962bbd11fe98e0c58f1b80eab9bcdf',
    'v121 remains byte-for-byte preserved as the RC.69 active source-pin fixture');
  const historicalV122 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v122.json'));
  assert.equal(createHash('sha256').update(historicalV122).digest('hex'), 'f930059af96e6113e8fef0f45d7c1910ded9336f55e713e493871ea4dc579063',
    'v122 remains byte-for-byte preserved as the RC.70 initial source-draft-binding provenance fixture');
  const historicalV123 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v123.json'));
  assert.equal(createHash('sha256').update(historicalV123).digest('hex'), 'b1cd0e80259cda88759215f78641663369a3befc7212eeb394a20851e32aaeaa',
    'v123 remains byte-for-byte preserved as the RC.70 source-draft-binding active fixture');
  const historicalV124 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v124.json'));
  assert.equal(createHash('sha256').update(historicalV124).digest('hex'), 'efe0d818e7f7c7de01e59dd758a75bf7e923f591113f418b9bccb377f29c5427',
    'v124 remains byte-for-byte preserved as the first RC.71 Approval Subsystem provenance fixture');
  const historicalV125 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v125.json'));
  assert.equal(createHash('sha256').update(historicalV125).digest('hex'), '7c36e46c246906fa44da7aa3704c3bdd8d4a7b9877783933e5879301dedc66dd',
    'v125 remains byte-for-byte preserved as the corrected RC.71 benchmark provenance successor');
  const historicalV126 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v126.json'));
  assert.equal(createHash('sha256').update(historicalV126).digest('hex'), 'e519e5748a800f1738a16f1aa8c606848dd605f3a84fbb31dc79eb18bc6929c8',
    'v126 remains byte-for-byte preserved as the RC.71 source-chain closure successor');
  const historicalV127 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v127.json'));
  assert.equal(createHash('sha256').update(historicalV127).digest('hex'), 'e5f1cbcb5bd42992f31fc3bdd67da26ad724ad21e6493affed257787ad3422d3',
    'v127 remains byte-for-byte preserved as the RC.71 benchmark source-closure fixture');
  const historicalV128 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v128.json'));
  assert.equal(createHash('sha256').update(historicalV128).digest('hex'), 'cfb5cfc89d69f8231afc27fcda7f4818851a1a1422e407a2b018d09b6a2e0f81',
    'v128 remains byte-for-byte preserved as the RC.71 source-pin refresh for approval guidance');
  const historicalV129 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v129.json'));
  assert.equal(createHash('sha256').update(historicalV129).digest('hex'), '1bb95e9d59b9766937e55b525dc2c5fc85d6b0caf7c83aa17afdb9afa6482d95',
    'v129 remains byte-for-byte preserved as the RC.71 five-domain manifest contract fixture');
  const historicalV130 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v130.json'));
  assert.equal(createHash('sha256').update(historicalV130).digest('hex'), '6c2f711d47a371287640ab91626a853eeb107db56f315c72fa8a1a6a32a0ed90',
    'v130 remains byte-for-byte preserved as the RC.71 host administrator wording fixture');
  const historicalV131 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v131.json'));
  assert.equal(createHash('sha256').update(historicalV131).digest('hex'), 'f08c0eb37eef43960df93a472fcecf45a3e458e3759a8e735c38185c18cd8e1f',
    'v131 remains byte-for-byte preserved as the RC.71 public-key-only manifest fixture');
  const historicalV132 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v132.json'));
  assert.equal(createHash('sha256').update(historicalV132).digest('hex'), '065d4d3020c335a57fb7dcd89d6521f5ca910b50ba7ad1b5c8b18e457fdf68c8',
    'v132 remains byte-for-byte preserved as the RC.71 active-runtime tool-guidance fixture');
  const historicalV133 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v133.json'));
  assert.equal(createHash('sha256').update(historicalV133).digest('hex'), '1ec1ffc08811816b5c9dfb0122e5a7a43387e5216c1eb9d86ad6142aaf9149cc',
    'v133 remains byte-for-byte preserved as the RC.71 signed-approval plugin-test fixture');
  const historicalV134 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v134.json'));
  assert.equal(createHash('sha256').update(historicalV134).digest('hex'), '64116144172f9990578e81ffaa4dd1ba3102767c8c3c3b30302f0d627b2112dd',
    'v134 remains byte-for-byte preserved as the RC.71 isolated-workspace closure fixture');
  const historicalV135 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v135.json'));
  assert.equal(createHash('sha256').update(historicalV135).digest('hex'), 'aa446733e3ce05fa026c70cce8513b9199b0fda35d5fa55284b608070185b37e',
    'v135 remains byte-for-byte preserved as the RC.71 provenance-chain fixture');
  const historicalV136 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v136.json'));
  assert.equal(createHash('sha256').update(historicalV136).digest('hex'), '4f897b9d7fb981ec7ff9927aeed8631acbb3a35f27a594c06775652776c5bf0b',
    'v136 remains byte-for-byte preserved as the RC.71 idempotent approval-preflight fixture');
  const historicalV137 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v137.json'));
  assert.equal(createHash('sha256').update(historicalV137).digest('hex'), 'aa2392157cfecb6e38a60e176eab52bff8faefbe95566326f610a718e7cf6ecc',
    'v137 remains byte-for-byte preserved as the RC.71 approval retry closure fixture');
  const historicalV86 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v86.json'));
  assert.equal(createHash('sha256').update(historicalV86).digest('hex'), 'd46484a780da90743f032f080eeb82bb3d14adad59b29c6a7a25a920c491fe69',
    'v86 remains byte-for-byte preserved as the RC.45 historical fixture');
  const historicalV83 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v83.json'));
  assert.equal(createHash('sha256').update(historicalV83).digest('hex'), '846959161809db6741cc4367432b0669b9ee8f8f725043e92dd680c5e2ca0061',
    'v83 remains byte-for-byte preserved as the RC.43 historical fixture');
  const historicalV71 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v71.json'));
  assert.equal(createHash('sha256').update(historicalV71).digest('hex'), 'feef551082323f804863f215531f280b6bd1da461b25833813e0ba0ab8bfc331',
    'v71 remains byte-for-byte preserved as the frozen historical fixture');
  const historicalV76 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v76.json'));
  assert.equal(createHash('sha256').update(historicalV76).digest('hex'), 'f796fcc223ae4c098b07293eed47b92f946c40084080267bceed34f5b077e64b',
    'v76 remains byte-for-byte preserved as the RC.36 source identity fixture');
  const historicalV77 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v77.json'));
  assert.equal(createHash('sha256').update(historicalV77).digest('hex'), '0022a8e532ab4d4264e3f1e7c01ddfbdb22dcdd1a99b84c5995511c24be24137',
    'v77 remains byte-for-byte preserved as the RC.37 source identity fixture');
  const historicalV78 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v78.json'));
  assert.equal(createHash('sha256').update(historicalV78).digest('hex'), '5ead8f79adc14c09a3891b79868ef04e5c5c07b7cdd609bc0778c764b7ce9645',
    'v78 remains byte-for-byte preserved as the RC.38 pre-final source identity fixture');
  const historicalV79 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v79.json'));
  assert.equal(createHash('sha256').update(historicalV79).digest('hex'), '4ebeae237a04caa1ce2f95b362013a1e158e7abb1b132bca363394186e7e83ac',
    'v79 remains byte-for-byte preserved as the RC.38 final source identity fixture');
  const historicalV80 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v80.json'));
  assert.equal(createHash('sha256').update(historicalV80).digest('hex'), 'a77803274a434288412cffa27532ac99e8efd13169677f85dc3c99c81b7df2d2',
    'v80 remains byte-for-byte preserved as the RC.39 source identity fixture');
  const historicalV73 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v73.json'));
  assert.equal(createHash('sha256').update(historicalV73).digest('hex'), '9213fa11782b80b14165042997ffbaad8b88228da1f3813ec761f0fa8a4d50ad',
    'v73 remains byte-for-byte preserved as the RC.31 source identity fixture');
  const historicalV72 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v72.json'));
  assert.equal(createHash('sha256').update(historicalV72).digest('hex'), 'cb1ff3f506ad9ac9bcbe03293b400614ea931c096c89aa8c8d839135b66357a6',
    'v72 remains byte-for-byte preserved as the RC.30 source identity fixture');
  const historicalFixtureHashes = new Map([
    [99, '5fe6b907f7f3833985649cde5ae25d31ef28fe8c6a922b6c2fdd57563d7cde65'],
    [100, '167c4d0ae9979a52a37f3b01c94208288e3330c81c03d9db7b40c82a693f1ecd'],
    [101, '43e3b7bb42fcbc3034168bdad35b8df32448f54b329fb4522716c8ba2a08b76c'],
    [102, 'ec74a32ee4274b529baf0ff9a719cc531a1b3adc2a7cf8aac4fb4483d06f2191'],
    [103, '37fb80b8c9fa6617ba5af4706f83c6f4437667aa1aaa21cf94afc4cb7068b2ef'],
    [104, '54e26d7f74ca67e48a1f67ba3b2b7bc1b27f9606b143454b2279b6a4d9c6f465'],
    [105, '2085305831744801664d6991539ab8cc7a515d210ffac164e3c984747e4eea43'],
    [106, '8d032eea661996da4158a86b132431cf1a5b754471503399a364c3670ecbb86d'],
    [107, '2c63ea5a2be2e56bdfca14e7e39a1c8a6854e0b68cfd155cee7b4afccdd68a38'],
    [108, 'c9dbc751818709abb07f7861febc07e0b1a4f38fbb4b4ddde043d7195a190cc2'],
    [109, 'f33d3556047172efa80a9de1ba04e87e4b84dba2d886f1ffce4b3dd3a201daf8'],
    [110, '69fcf491e8782df86dfb0ddd8db5a78db1016480961a1bd7ccfb49a3ab4b1a6f'],
    [111, '2ef46dc4a112e9d9666840364504aaa95a0102f019cf5b903af72f9f420a927e'],
    [112, '8f1856d30501847daa672cf54b5b8cd8cce580a391925f0a3c25d7212fb3a623'],
    [113, '9e931bfdbc5872cb5a76654706d5f02ddf207c18ea35d7d727d3dd19c1030c0f'],
    [114, 'eff6248ae349d9b5c53485773599bb5b2bfd24ca6d32c42c12f6d4c8d8aaba60'],
    [115, '975f4c24e76661da8f9c29805fcb74556f51d5f108ce528fc1f2c477ee2eb749'],
    [116, '0c7ee465eb995e0b42d8ef6efc1fa4b0e9623c285ba66d1a3cdf2ee1371204b9'],
    [117, 'f0dc190bdff5d4e3a28d94fa2dd38cfc9c9e24acd71a2918e74807cf142f4b6c'],
    [118, '13b9cea8e410420fcc5bac94c1d9aeddffec60d5f28f282f8871bf684fa8c803'],
    [119, 'e6178d36cc9db520d5a4e7964c3f3c8e36e6533a072e39b153d4c95d2bd998c7'],
    [120, '365d3d3fc55a17e9c5216fd3637fe937f3ff18ba92adfd077423c768e86d9af8'],
    [121, '2c0fdf698b9b51434ba48a5eb2d6f4fdec962bbd11fe98e0c58f1b80eab9bcdf'],
    [122, 'f930059af96e6113e8fef0f45d7c1910ded9336f55e713e493871ea4dc579063'],
    [123, 'b1cd0e80259cda88759215f78641663369a3befc7212eeb394a20851e32aaeaa'],
    [124, 'efe0d818e7f7c7de01e59dd758a75bf7e923f591113f418b9bccb377f29c5427'],
    [125, '7c36e46c246906fa44da7aa3704c3bdd8d4a7b9877783933e5879301dedc66dd'],
    [126, 'e519e5748a800f1738a16f1aa8c606848dd605f3a84fbb31dc79eb18bc6929c8'],
    [127, 'e5f1cbcb5bd42992f31fc3bdd67da26ad724ad21e6493affed257787ad3422d3'],
    [128, 'cfb5cfc89d69f8231afc27fcda7f4818851a1a1422e407a2b018d09b6a2e0f81'],
    [129, '1bb95e9d59b9766937e55b525dc2c5fc85d6b0caf7c83aa17afdb9afa6482d95'],
    [130, '6c2f711d47a371287640ab91626a853eeb107db56f315c72fa8a1a6a32a0ed90'],
    [131, 'f08c0eb37eef43960df93a472fcecf45a3e458e3759a8e735c38185c18cd8e1f'],
    [132, '065d4d3020c335a57fb7dcd89d6521f5ca910b50ba7ad1b5c8b18e457fdf68c8'],
    [133, '1ec1ffc08811816b5c9dfb0122e5a7a43387e5216c1eb9d86ad6142aaf9149cc'],
    [134, '64116144172f9990578e81ffaa4dd1ba3102767c8c3c3b30302f0d627b2112dd'],
    [135, 'aa446733e3ce05fa026c70cce8513b9199b0fda35d5fa55284b608070185b37e'],
    [136, '4f897b9d7fb981ec7ff9927aeed8631acbb3a35f27a594c06775652776c5bf0b'],
    [137, 'aa2392157cfecb6e38a60e176eab52bff8faefbe95566326f610a718e7cf6ecc'],
    [138, 'ceda73ff0d7f48b375fda93601d913edb6567ce8dadfe3ba33c1826b75f7fc18'],
    [139, '2a608188438bc8a443bf5acf0ddefe917a6702c95092900e777658c0f2696318'],
    [140, '4e68b9c6af310ac6a82374d141f7aeacf57f70c1c66e4c075554a67c9df3182f'],
    [141, '34a1601f636873eb112e0df8b4202c6bdbdcb76ac5257570785147dfe523d111'],
    [142, '9fda3223a497e868115518445f20376c0e80e4c6d877c4295f29792da67e7f3c'],
    [143, 'b9c6ac01f65c5f925f829b2df5a2b98f5324b076163b96fed7feac4bcd8a6310'],
    [144, 'c4ff1eff737388bff8c18ff0d51939323e50c6f705454d26e51b128c6d84d8db'],
    [145, '9d7d73d8cf65043f51dac5541962f3088646af8a769efa623a63c569e676b61b'],
    [146, '5eec91752ccd72d1caa4d0f851ea2e71a2525c4b5d9a56062339e22663b54133']
  ]);
  const historicalFixtureBytes = new Map();
  for (const [version, expectedHash] of historicalFixtureHashes) {
    const bytes = fs.readFileSync(path.join(root, `benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v${version}.json`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash,
      `v${version} remains byte-for-byte immutable historical benchmark evidence`);
    historicalFixtureBytes.set(version, bytes);
  }
  const historicalV99 = historicalFixtureBytes.get(99);
  const historicalV100 = historicalFixtureBytes.get(100);
  const historicalV101 = historicalFixtureBytes.get(101);
  const historicalV102 = historicalFixtureBytes.get(102);
  const historicalV103 = historicalFixtureBytes.get(103);
  const historicalV104 = historicalFixtureBytes.get(104);
  const historicalV105 = historicalFixtureBytes.get(105);
  const historicalV106 = historicalFixtureBytes.get(106);
  const historicalV107 = historicalFixtureBytes.get(107);
  const historicalV87 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v87.json'));
  assert.equal(createHash('sha256').update(historicalV87).digest('hex'), '285d117544bc51fc6aced4c6dc63d7bec162a7457286f94df295ff6f525638d6',
    'v87 remains byte-for-byte preserved as the RC.46 source identity fixture');
  const historicalV95 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v95.json'));
  assert.equal(createHash('sha256').update(historicalV95).digest('hex'), '228d515e7f117b01401be5cbef89b843fc9299ecfb8d11625ec27d4a5c4a3a1e',
    'v95 remains byte-for-byte preserved as the RC.57 source identity fixture');
  const historicalV96 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v96.json'));
  assert.equal(createHash('sha256').update(historicalV96).digest('hex'), '5e5839bc6f47201426eaf66906ad5c8ac24c55f32722c8f3f12ff64da449b7f0',
    'v96 remains byte-for-byte preserved as the RC.59 source identity fixture');
  const historicalV98 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v98.json'));
  assert.equal(createHash('sha256').update(historicalV98).digest('hex'), '4b0f515b9ddb2eae4861e0d91eea2efa30403e64d1a818d2891433b9550549ca',
    'v98 remains byte-for-byte preserved as the RC.61 source identity fixture');
  const historicalV97 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v97.json'));
  assert.equal(createHash('sha256').update(historicalV97).digest('hex'), 'd80b621e9390b9fa77e276f30a51f607586b7f606bee387a2145ea210951a0b6',
    'v97 remains byte-for-byte preserved as the RC.60 source identity fixture');
  const historicalV82 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v82.json'));
  assert.equal(createHash('sha256').update(historicalV82).digest('hex'), 'e102341de1278fb84d41b7e838209c399241e91c3f06150ccb4278c282a7486c',
    'v82 remains byte-for-byte preserved as the RC.42 source identity fixture');
  const historicalV69 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v69.json'));
  assert.equal(createHash('sha256').update(historicalV69).digest('hex'), 'eb8a5626e654c1bfeac0d4e7b19c5208334f48b5241f28ed817922967f81a678',
    'v69 remains byte-for-byte preserved as the RC.27 source identity fixture');
  const historicalV68 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v68.json'));
  assert.equal(createHash('sha256').update(historicalV68).digest('hex'), 'bf36bd82a086c0aedf5f0bfebd02dc9fe16446d6ef21c964a85d6fbbff142a1d',
    'v68 remains byte-for-byte preserved as the RC.26 source identity fixture');
  const historicalV67 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v67.json'));
  assert.equal(createHash('sha256').update(historicalV67).digest('hex'), '217c86983b17636e9ed3d14c3eae064d76ca69a158210ed0eb78e1d8871570a1',
    'v67 remains byte-for-byte preserved as the RC.25 source identity fixture');
  const historicalV66 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v66.json'));
  assert.equal(createHash('sha256').update(historicalV66).digest('hex'), 'c300d1c2d79c1ec40a02d0a312547ec39fb77bb6f3d3aee5b90fd0e479f3ae7c',
    'v66 remains byte-for-byte preserved as the RC.24 source identity fixture');
  const historicalV65 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v65.json'));
  assert.equal(createHash('sha256').update(historicalV65).digest('hex'), '40acdf4ac7cb4ab9b403b53702ee0e79744ec5bdc4b9b095ced85445bae4a19c', 'v65 remains byte-for-byte preserved as the source-mismatch recovery fixture');
  assert.equal(fixture.schemaVersion, 117);
  assert.equal(fixture.fixtureId, 'recovery-verifier-investigation-v117');
  assert.equal(fixture.supersedesFixtureId, 'recovery-verifier-investigation-v116');
  const historicalFixtureObjects = new Map([...historicalFixtureBytes].map(([version, bytes]) => [version, JSON.parse(bytes.toString('utf8'))]));
  const historicalV99Fixture = historicalFixtureObjects.get(99);
  const historicalV100Fixture = historicalFixtureObjects.get(100);
  const historicalV101Fixture = historicalFixtureObjects.get(101);
  const historicalV102Fixture = historicalFixtureObjects.get(102);
  const historicalV103Fixture = historicalFixtureObjects.get(103);
  const historicalV104Fixture = historicalFixtureObjects.get(104);
  const historicalV105Fixture = historicalFixtureObjects.get(105);
  const historicalV106Fixture = historicalFixtureObjects.get(106);
  const historicalV107Fixture = historicalFixtureObjects.get(107);
  const historicalV108Fixture = historicalFixtureObjects.get(108);
  const historicalV109Fixture = historicalFixtureObjects.get(109);
  const historicalV110Fixture = historicalFixtureObjects.get(110);
  const historicalV111Fixture = historicalFixtureObjects.get(111);
  const historicalV112Fixture = historicalFixtureObjects.get(112);
  const historicalV113Fixture = historicalFixtureObjects.get(113);
  const historicalV114Fixture = historicalFixtureObjects.get(114);
  const historicalV115Fixture = historicalFixtureObjects.get(115);
  const historicalV116Fixture = historicalFixtureObjects.get(116);
  const readmeHash = createHash('sha256').update(fs.readFileSync(path.join(root, 'docs/README.md'))).digest('hex');
  const historicalReadmePin = historicalV99Fixture.provenance.find(item => item.path === 'docs/README.md');
  assert.equal(historicalReadmePin.sha256, 'e956f53344de2963427ab07baa711f164d2c3bb28301ff606647702eb86e548e',
    'v99 preserves the original README mismatch source hash');
  assert.notEqual(historicalReadmePin.sha256, readmeHash,
    'the historical README mismatch remains visible');
  const readmePinV100 = historicalV100Fixture.provenance.find(item => item.path === 'docs/README.md');
  assert.equal(readmePinV100.previouslyPinnedBeforeRC63RefreshSha256, historicalReadmePin.sha256,
    'v100 carries the exact pre-refresh README pin');
  assert.equal(readmePinV100.sha256, readmeHash,
    'v100 pins the reviewed current README bytes');
  for (const version of [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147]) {
    const selected = version === 147 ? fixture : historicalFixtureObjects.get(version);
    const readmePin = selected.provenance.find(item => item.path === 'docs/README.md');
    assert.equal(readmePin.sha256, readmeHash, `v${version} binds current README bytes`);
    assert.equal(readmePin.previouslyPinnedBeforeRC63RefreshSha256, historicalReadmePin.sha256,
      `v${version} preserves original README mismatch lineage`);
  }
  for (const version of [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 144, 145, 146]) {
    const selected = historicalFixtureObjects.get(version);
    assert.deepEqual(selected.groundTruth, fixture.groundTruth, `v${version} graph/scoring oracle remains unchanged`);
    assert.deepEqual(selected.tasks, fixture.tasks, `v${version} task/node/edge identities remain unchanged`);
  }

  const currentSourceDigest = relative => createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
  const refreshedPins = [
    'benchmarks/adaptive-goal-graph/run-benchmark.mjs',
    'tests/test-adaptive-goal-benchmark.mjs',
    'benchmarks/plugin-workflow-benchmark/test-create-phase2-candidate-inventory.mjs',
    'tests/test-mcp-eof-shutdown-framing-20261017.js',
    'package.json',
    'package-lock.json',
    'plugin/manifest.json',
    'scripts/verify-mcpb-source-alignment.mjs',
    'scripts/runalith-rollout.mjs',
    'tests/test-runalith-rollout.mjs',
    'docs/agg-production-trust-provisioning-runbook.md',
    'scripts/package-runalith-mcpb.sh',
    'tests/test-runalith-plugin.js'
  ];
  for (const relative of refreshedPins) {
    const currentPin = fixture.provenance.find(item => item.path === relative);
    const predecessorPin = historicalFixtureObjects.get(146)?.provenance.find(item => item.path === relative);
    assert.ok(currentPin && predecessorPin, 'v146/v147 both preserve source pin ' + relative);
    assert.equal(currentPin.sha256, currentSourceDigest(relative), 'v147 pins exact current source bytes for ' + relative);
    if (currentPin.sha256 !== predecessorPin.sha256) {
      assert.equal(currentPin.previouslyPinnedBeforeRC71V147Sha256, predecessorPin.sha256,
        'v147 records the exact predecessor source digest for changed bytes at ' + relative);
    } else {
      assert.equal(currentPin.previouslyPinnedBeforeRC71V147Sha256, undefined,
        'v147 does not invent a predecessor transition for unchanged bytes at ' + relative);
    }
  }
  for (const relative of [
    'tests/test-adaptive-goal-current-scope-producer-e2e.mjs',
    'server/index.js',
    'server/index-v1.0.9-rc.63.js',
    'server/index-v1.0.9-rc.64.js',
    'server/index-v1.0.9-rc.65.js',
    'server/index-v1.0.9-rc.66.js',
    'server/index-v1.0.9-rc.67.js',
    'server/index-v1.0.9-rc.68-reviewer-attestation-ingestion-20261029.js',
    'server/index-v1.0.9-rc.69-reviewer-attestation-ingestion-provenance-v120-20261029.js',
    'server/index-v1.0.9-rc.70-execution-graph-source-draft-binding-v122-20261030.js',
    'server/index-v1.0.9-rc.70-execution-graph-source-draft-binding-v123-20261030.js',
    'server/index-v1.0.9-rc.71-versioned-approval-subsystem-20261030.js',
    'src/runtime/adaptive-goal-approval-subsystem.js',
    'tests/test-adaptive-goal-approval-subsystem.mjs',
    'docs/adaptive-goal-approval-subsystem.md',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v120.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v121.json',
    'src/runtime/adaptive-goal-execution-graph-proposal.js',
    'src/runtime/adaptive-goal-execution-plan-candidate.js',
    'tests/test-adaptive-goal-execution-graph-proposal.js',
    'docs/execution-graph-source-draft-binding.md',
    'src/runtime/adaptive-goal-reviewer-identity.js',
    'tests/test-adaptive-goal-reviewer-identity.js',
    'tests/test-runalith-plugin.js',
    'docs/adaptive-goal-reviewer-attestation-ingestion.md',
    'docs/adaptive-goal-graph.md',
    'docs/MCP_REFERENCE.md',
    'scripts/build-agg-readiness-dossier.mjs',
    'tests/test-agg-readiness-dossier.mjs',
    'tests/test-adaptive-goal-benchmark.mjs',
    'tests/test-extracted-package-tool-schemas.mjs',
    'package.json',
    'package-lock.json',
    'plugin/manifest.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v119.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v123.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v124.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v125.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v126.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v127.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v128.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v129.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v130.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v131.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v132.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v133.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v134.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v135.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v136.json',
    'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v137.json',
    'tests/test-mcp-shutdown-backpressure-deadline-20261017.js'
  ]) {
    const currentPin = fixture.provenance.find(item => item.path === relative);
    const predecessorPin = historicalFixtureObjects.get(146)?.provenance.find(item => item.path === relative);
    assert.ok(currentPin, 'v147 preserves source pin ' + relative);
    assert.equal(currentPin.sha256, currentSourceDigest(relative), 'v147 binds current bytes for ' + relative);
    if (predecessorPin) {
      if (currentPin.sha256 !== predecessorPin.sha256) {
        assert.equal(currentPin.previouslyPinnedBeforeRC71V147Sha256, predecessorPin.sha256,
          'v147 preserves predecessor source identity for changed bytes at ' + relative);
      } else {
        assert.equal(currentPin.previouslyPinnedBeforeRC71V147Sha256, undefined,
          'v147 does not invent a source transition for unchanged bytes at ' + relative);
      }
    }
  }
  for (const version of [101, 102, 103, 104, 105, 106, 107]) {
    assert.equal(historicalFixtureObjects.get(version).fixtureId, `recovery-verifier-investigation-v${version}`);
  }
  assert.equal(fixture.provenance.some(item => item.path === 'docs/runalith-rollout-rc40-20261028.md'), false,
    'candidate-specific operator handoff is excluded from its own source-pin fixture to avoid self-reference');
  const historicalV64 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v64.json'));
  assert.equal(createHash('sha256').update(historicalV64).digest('hex'), '497e6a91e17fe3b052be6c109e64b16cc377d334a294f5b1bd18f41deb5f3641',
    'v64 remains byte-for-byte preserved as the first actionable historical source-mismatch recovery fixture');
  const historicalV63 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v63.json'));
  assert.equal(createHash('sha256').update(historicalV63).digest('hex'), '9012aeca46569d9c8851150cf92f1be9a4903cb97baa0c2895cbf88526874868',
    'v63 remains byte-for-byte preserved as the prior actionable source-coverage fixture');
  const historicalV59 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v59.json'));
  assert.equal(createHash('sha256').update(historicalV59).digest('hex'), '0728a350c32908857a959cfef7e3287d5ec26469239cf1806ceae7abc572443e',
    'v59 remains byte-for-byte preserved as the prior immutable source-pinning fixture');
  const historicalV52 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v52.json'));
  assert.equal(createHash('sha256').update(historicalV52).digest('hex'), '9d0ea027868a9af05a6dc47f8d257f4d286e054c5de1bdf847a9604a9c95d717',
    'v52 remains byte-for-byte preserved as the prior atomic checkpoint lineage fixture');
  const historicalV53 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v53.json'));
  assert.equal(createHash('sha256').update(historicalV53).digest('hex'), '0b72ebed63000302b1f81402c1f1c7db5507613d4b232d0b2f3d1991624e432e',
    'v53 remains byte-for-byte preserved as the prior checkpoint hardening fixture');
  const historicalV54 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v54.json'));
  assert.equal(createHash('sha256').update(historicalV54).digest('hex'), '065194960fe36efca238f17030e6bab9dcfbcfaeff5d5bcf072426c466ec66cf',
    'v54 remains byte-for-byte preserved as the prior Execution Graph/checkpoint implementation fixture');
  const historicalV55 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v55.json'));
  assert.equal(createHash('sha256').update(historicalV55).digest('hex'), '5734b77d91f286b4a7f70d14029e52e38896f993c39273c0891a207952a04538',
    'v55 remains byte-for-byte preserved as the prior rollout source-pin successor');
  const historicalV56 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v56.json'));
  assert.equal(createHash('sha256').update(historicalV56).digest('hex'), '0683058ad3cf65d604738b8bda0f1b933731540c8a73cea31eaab229e1a69833',
    'v56 remains byte-for-byte preserved as the prior graph/checkpoint source-closure fixture');
  const historicalV57 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v57.json'));
  assert.equal(createHash('sha256').update(historicalV57).digest('hex'), 'c70cb2127cdda0b9e0c4e24e19e8be45f2fdd8480e7ad78a2eeadfc77ff6eca3',
    'v57 remains byte-for-byte preserved as the prior full source-scope-pinning fixture');
  const historicalV58 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v58.json'));
  assert.equal(createHash('sha256').update(historicalV58).digest('hex'), '4e311b3d5b41e18c7524f662df4ce0353414e67bd1ae045908f6b8494b7f82fd',
    'v58 remains byte-for-byte preserved as the prior canonical-release-scope fixture');
  const historicalV51 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v51.json'));
  assert.equal(createHash('sha256').update(historicalV51).digest('hex'), 'b1ed0df95403e420b03d291cfa39dc66c85e214044d422496332c59dfc732ead',
    'v51 remains byte-for-byte preserved as the first cross-graph lineage gate successor');
  const historicalV49 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v49.json'));
  assert.equal(createHash('sha256').update(historicalV49).digest('hex'), '70f56ab4c0da6e5ea9acc0abc7527212d113f196206f60c0b9ebc92632f3ddcd',
    'v49 remains byte-for-byte preserved as the rollout source-pin checkpoint');
  const historicalV48 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v48.json'));
  assert.equal(createHash('sha256').update(historicalV48).digest('hex'), '43408b90ca7cb083bd90e00cdd34ec163ed6fa3e292b4a17739d999995e89065',
    'v48 remains byte-for-byte preserved as the inert-JSON checkpoint-contract successor');
  const historicalV47 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v47.json'));
  assert.equal(createHash('sha256').update(historicalV47).digest('hex'), '8764d590818b43a0c18758cff8a5b0b12f844268b5379671de3dae577eddd3d2',
    'v47 remains byte-for-byte preserved as the RC.16 historical provenance fixture');
  const historicalV46 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v46.json'));
  assert.equal(createHash('sha256').update(historicalV46).digest('hex'), 'af1197fa544a0a1012785409abb39a1dc0b2e2d708d67f6046e652aee5a88eae',
    'v46 remains byte-for-byte preserved as the RC.15 baseline fixture');
  const historicalV41 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v41.json'));
  assert.equal(createHash('sha256').update(historicalV41).digest('hex'), '78c90a8bcddd6993ac5a81837d5c15b834ea13def7234b084472e3ff24f58e19',
    'v41 remains byte-for-byte preserved as the prior RC.13 provenance fixture');
  const historicalV39 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v39.json'));
  assert.equal(createHash('sha256').update(historicalV39).digest('hex'), 'a914ba38828665a2d9190c040d2d0c5d7bfdc8d0184e8336c4e7cb9cfabdf952',
    'v39 remains byte-for-byte preserved as the repeated-identity canonicalization successor');
  const historicalV38 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v38.json'));
  assert.equal(createHash('sha256').update(historicalV38).digest('hex'), '128ac4ee4b78f7a1107eb8721cd6e0d61e262ca6ebf53946679adbbf6c3ed62c',
    'v38 remains byte-for-byte preserved as the prior non-enumerable-property canonicalization successor');
  const historicalV37 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v37.json'));
  assert.equal(createHash('sha256').update(historicalV37).digest('hex'), '1258f5a91a17bf070cbfb69c9944c73c9add91010841e15d635d9644e832ec6b',
    'v37 remains byte-for-byte preserved as the source-provenance completeness successor');
  const historicalV36 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v36.json'));
  assert.equal(createHash('sha256').update(historicalV36).digest('hex'), 'bdaa67d48779887e0946d931cb7eda7bc14f86b70d09c2c5be90215cbcfbf193',
    'v36 remains byte-for-byte preserved as the previous strict canonicalization successor');
  const historicalV35 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v35.json'));
  assert.equal(createHash('sha256').update(historicalV35).digest('hex'), '99faaad1ef4c272be959928a209ff9c82fbf504c7290f9fb370e8104dc4a496e',
    'v35 remains byte-for-byte preserved as the prior Execution Graph canonicalization successor');
  const historicalV34 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v34.json'));
  assert.equal(createHash('sha256').update(historicalV34).digest('hex'), 'ca0795afe09fe5c86a53c26c2e6aa5f0bef46d4a9ef437ce17cb1bb6ef8b4fa8',
    'v34 remains byte-for-byte preserved as the prior Execution Graph integrity successor');
  const historicalV33 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v33.json'));
  assert.equal(createHash('sha256').update(historicalV33).digest('hex'), '274f5fc88c4f22e815c0ee1c6742c14b0ced08ef9e7e265336b1d2d54f745c53',
    'v33 remains byte-for-byte preserved as the integrated release-trust successor');
  const historicalV32 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v32.json'));
  assert.equal(createHash('sha256').update(historicalV32).digest('hex'), 'c94ad60d6add03603c28f9d0706992a070e0e69ed4c0fc7576f9f79e1724153b',
    'v32 remains byte-for-byte preserved as the acceptance-chain integration successor');
  const historicalV31 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v31.json'));
  assert.equal(createHash('sha256').update(historicalV31).digest('hex'), '9f492abc09c2c6fbaaedc676b8973cb23040edb0ff3e8752e6aa25f29d60af91',
    'v31 remains byte-for-byte preserved as the dependency-hardening successor');
  const historicalV30 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v30.json'));
  assert.equal(createHash('sha256').update(historicalV30).digest('hex'), 'd54ce41ef232d6100b8a7c8a8b1cf4cc0f6640becbf06a203bb9b068c38cf620',
    'v30 remains byte-for-byte preserved as the prior integrated reconciliation fixture');
  const historicalV28 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v28.json'));
  assert.equal(createHash('sha256').update(historicalV28).digest('hex'), '565eaec74b65d526dd1f7eda8087f13ea28e9a57c3a45d199a44dafad7606ba7',
    'v28 archive-lineage fixture remains byte-for-byte preserved; v29 is a reviewed successor, not a rewrite');
  const historicalV29 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v29.json'));
  assert.equal(createHash('sha256').update(historicalV29).digest('hex'), 'fce8c2346bfc5f2c057ac70509ca43c0cc6c68f0dfab55507ac3c23b8756b69d',
    'v29 source pins remain byte-for-byte preserved; v30 is a new successor after subsequent reconciliation fixes');
  const historicalV27 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v27.json'));
  assert.equal(createHash('sha256').update(historicalV27).digest('hex'), '8e873b80cfc5fce6336328f9e890591b7c29d19411ca83b3e5a54578374c7e60',
    'v27 workflow-selection fixture remains byte-for-byte preserved as the prior successor');
  const historicalV26 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v26.json'));
  assert.equal(createHash('sha256').update(historicalV26).digest('hex'), '416281b36aaf783b0d5d87cd5374bf90a2f8f8f849800d36fb15092e712f2283',
    'v26 verifier-freshness fixture remains byte-for-byte preserved as the prior successor');
  const historicalV25 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v25.json'));
  assert.equal(createHash('sha256').update(historicalV25).digest('hex'), 'da6162a48a341434f3e32a7ddc2e697251df3b1e413cdce951099660b2a7f5dd',
    'v25 remains byte-for-byte preserved as the previous source-pin fixture');
  const historicalV24 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v24.json'));
  assert.equal(createHash('sha256').update(historicalV24).digest('hex'), 'fe4e2755c4253a297daca657b5ce087e4705d642b484f53e2b601d4f421ed224',
    'v24 source-pin provenance remains byte-for-byte preserved as the previous successor fixture');
  const historicalV22 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v22.json'));
  assert.equal(createHash('sha256').update(historicalV22).digest('hex'), 'c373e1e658b321f51817b906c021009bf087c4d28ecc9d96e93f3bf3ddbb87c1',
    'v22 provenance mismatch fixture remains byte-for-byte preserved as a historical artifact');
  const historicalV23 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v23.json'));
  assert.equal(createHash('sha256').update(historicalV23).digest('hex'), '9854e452e784dca8fcc6a2cf444832f400ff994a1afc43e37e72a4da70019588',
    'v23 source-pin provenance remains byte-for-byte preserved as the prior successor fixture');
  const historicalV20 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v20.json'));
  assert.equal(createHash('sha256').update(historicalV20).digest('hex'), '5f5e4f16da60ec94a7dfd9f83abcba484b4ad072b529b48aa0344e6706bcd882',
    'v20 source-pin provenance remains byte-for-byte preserved after successor fixture updates');
  const historicalV17 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v17.json'));
  assert.equal(createHash('sha256').update(historicalV17).digest('hex'), '44f8646db18d15894f5a25b5a83e7256e8a4bb7ea75f28180d02af5a061c06b0',
    'v17 trust-pair provenance remains immutable after the checkpoint-gate hardening');
  const historicalV19 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v19.json'));
  assert.equal(createHash('sha256').update(historicalV19).digest('hex'), '9122ab7c84166eac6b150dae9192414a3a2498945bd9a852baed37ed91edc613',
    'v19 successor provenance remains immutable after RC.10 reviewer-ledger diagnostic hardening');
  const historicalV16 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v16.json'));
  assert.equal(createHash('sha256').update(historicalV16).digest('hex'), '24ea4df5b4e6af26c99b31b92bd31934dcba26b41e11a9744ccd2b2164d9d453',
    'v16 provenance must remain byte-for-byte preserved after the v18 checkpoint-gate hardening');
  const historicalV15 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v15.json'));
  assert.equal(createHash('sha256').update(historicalV15).digest('hex'), '8426c48bd5c1a583cd80a6b1e417fc837da0e89ac3d297fc71ecf7edda3e66c4',
    'v15 provenance must remain byte-for-byte preserved after successor source-pin refresh');
  const historicalV14 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v14.json'));
  assert.equal(createHash('sha256').update(historicalV14).digest('hex'), '224787fe0cc6be275217d6a55d19f988354ce90323a6db6ff46ea577aed09ac6',
    'v14 lineage/recovery provenance must remain byte-for-byte preserved');
  const historicalV13 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v13.json'));
  assert.equal(createHash('sha256').update(historicalV13).digest('hex'), '743390d3b61f4a6ff0b19811d91068ef9bb155be15cc969af662cc30307149c7',
    'v13 packaging provenance fixture must remain byte-for-byte preserved');
  const historicalV12 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v12.json'));
  assert.equal(createHash('sha256').update(historicalV12).digest('hex'), 'f4bbd5c784315400dc25ec63e7c0b683a0a1c637b242f2cdb19a9fd43974f17a',
    'v12 reconciliation provenance fixture must remain byte-for-byte preserved');
  const historicalV11 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v11.json'));
  assert.equal(createHash('sha256').update(historicalV11).digest('hex'), 'f21bf5101e7410b2dd8b92e85d9fb6af31e7667f296fe8bb8a66d90af0c59839',
    'v11 trust-hardening provenance fixture must remain byte-for-byte preserved');
  const historicalV10 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v10.json'));
  assert.equal(createHash('sha256').update(historicalV10).digest('hex'), '331911bd0b36bbbbe390ae10387a8a1172d3d1a257d9e5b1140d1e2839f4e6ee',
    'v10 is a historical source identity and must remain byte-for-byte preserved');
  assert.ok(fixture.provenance.length >= 15);
  const historicalV5 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v5.json'));
  assert.equal(createHash('sha256').update(historicalV5).digest('hex'), 'a50232e160660d655bfb6b23543d42aeb83ca742546c08b7d0a729b0de659f7d',
    'versioned v5 provenance fixture must remain byte-for-byte preserved');
  const historicalV6 = fs.readFileSync(path.join(root, 'benchmarks/adaptive-goal-graph/fixtures/recovery-verifier-v6.json'));
  assert.equal(createHash('sha256').update(historicalV6).digest('hex'), '342358144e9ae83b4b1865652fa4400fadb36231c4f38a683897dd801ab600e1',
    'versioned v6 provenance fixture must remain byte-for-byte preserved');
  assert.equal(new Set(fixture.provenance.map(source => source.path)).size, fixture.provenance.length);
  for (const source of fixture.provenance) {
    const bytes = fs.readFileSync(path.join(root, source.path));
    const observed = createHash('sha256').update(bytes).digest('hex');
    assert.equal(observed, source.sha256, `${source.path} provenance drifted; review fixture claims and update hash deliberately`);
    if (source.previouslyPinnedSha256 !== undefined) assert.match(source.previouslyPinnedSha256, /^[a-f0-9]{64}$/);
    if (source.historicalSnapshotPath !== undefined) assert.ok(source.historicalSnapshotPath.startsWith('artifacts/'), 'historical pin must retain its prior snapshot identity');
    assert.ok(source.claim.length > 20);
    if (source.semanticScope) {
      const content = bytes.toString('utf8');
      const start = content.indexOf(source.semanticScope.startMarker);
      const end = start < 0 ? -1 : content.indexOf(source.semanticScope.endMarker, start + source.semanticScope.startMarker.length);
      assert.ok(start >= 0 && end > start, `${source.path} semantic provenance markers must resolve to one source scope`);
      assert.equal(createHash('sha256').update(content.slice(start, end), 'utf8').digest('hex'), source.semanticScope.sha256,
        `${source.path} recovery-verifier scope drifted; review behavior and the scope pin deliberately`);
    }
  }
});

test('runner rejects source-byte drift even when the modified source remains readable', () => {
  const workspace = createIsolatedRunnerWorkspace();
  try {
    fs.appendFileSync(path.join(workspace, 'server/index.js'), '\n// TEST ONLY: unauthorized source-byte change\n');
    const result = runIsolated(workspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SOURCE_HASH_MISMATCH/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('runner rejects a modified whole-file pin when source bytes do not match it', () => {
  const workspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(workspace);
    copy.provenance[1].sha256 = 'f'.repeat(64);
    saveFixture(workspace, copy);
    const result = runIsolated(workspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SOURCE_HASH_MISMATCH/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('semantic recovery-verifier pin detects a changed function even if the whole-file digest is refreshed', () => {
  const workspace = createIsolatedRunnerWorkspace();
  try {
    const sourcePath = path.join(workspace, 'server/index.js');
    const altered = fs.readFileSync(sourcePath, 'utf8').replace(
      "case 'workflow_recovery_verify': {",
      "case 'workflow_recovery_verify': { /* TEST ONLY: modified recovery semantics */"
    );
    assert.notEqual(altered, fs.readFileSync(sourcePath, 'utf8'), 'test mutation must target the pinned function marker');
    fs.writeFileSync(sourcePath, altered);
    const copy = fixtureBytes(workspace);
    copy.provenance[0].sha256 = createHash('sha256').update(altered).digest('hex');
    saveFixture(workspace, copy);
    const result = runIsolated(workspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SCOPE_HASH_MISMATCH/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('runner rejects path traversal and symlink substitutions in provenance source paths', () => {
  const traversalWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(traversalWorkspace);
    copy.provenance[0].path = '../package.json';
    copy.provenance[0].sha256 = createHash('sha256').update(fs.readFileSync(path.join(traversalWorkspace, 'package.json'))).digest('hex');
    saveFixture(traversalWorkspace, copy);
    const result = runIsolated(traversalWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SOURCE_PATH_UNSAFE/);
  } finally { fs.rmSync(traversalWorkspace, { recursive: true, force: true }); }

  const symlinkWorkspace = createIsolatedRunnerWorkspace();
  try {
    const sourcePath = path.join(symlinkWorkspace, 'server/index.js');
    fs.unlinkSync(sourcePath);
    fs.symlinkSync(path.join(symlinkWorkspace, 'tests/test-runalith-plugin.js'), sourcePath);
    const result = runIsolated(symlinkWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SOURCE_SYMLINK/);
  } finally { fs.rmSync(symlinkWorkspace, { recursive: true, force: true }); }
});

test('runner rejects duplicate and malformed provenance records before reporting benchmark output', () => {
  const duplicateWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(duplicateWorkspace);
    copy.provenance.push(structuredClone(copy.provenance[0]));
    saveFixture(duplicateWorkspace, copy);
    const result = runIsolated(duplicateWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SOURCE_DUPLICATE/);
  } finally { fs.rmSync(duplicateWorkspace, { recursive: true, force: true }); }

  const malformedWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(malformedWorkspace);
    copy.provenance[0].semanticScope.startMarker = '';
    saveFixture(malformedWorkspace, copy);
    const result = runIsolated(malformedWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /PROVENANCE_SCOPE_INVALID/);
  } finally { fs.rmSync(malformedWorkspace, { recursive: true, force: true }); }
});

test('runner fixture selector rejects traversal and absolute fixture paths', () => {
  for (const unsafe of ['../recovery-verifier-v22.json', '/tmp/untrusted-fixture.json', 'fixtures/../recovery-verifier-v22.json']) {
    const result = spawnSync(process.execPath, [runnerPath, '--fixture', unsafe], { cwd: root, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0, `unsafe fixture path unexpectedly accepted: ${unsafe}`);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_FIXTURE_PATH_(UNSAFE|OUT_OF_SCOPE)/);
  }

  const workspace = createIsolatedRunnerWorkspace();
  try {
    const fixtureDirectory = path.join(workspace, 'benchmarks/adaptive-goal-graph/fixtures');
    fs.symlinkSync('recovery-verifier-v22.json', path.join(fixtureDirectory, 'fixture-link.json'));
    const result = spawnSync(process.execPath, [path.join(workspace, 'benchmarks/adaptive-goal-graph/run-benchmark.mjs'),
      '--fixture', 'fixtures/fixture-link.json'], { cwd: workspace, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_FIXTURE_SYMLINK/);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('offline benchmark is deterministic apart from measured wall-clock latency', () => {
  const first = run();
  const second = run();
  assert.deepEqual(stableProjection(first), stableProjection(second));
  assert.deepEqual(first.provenance, fixture.provenance, 'raw benchmark provenance must identify the exact fixture pins consumed by the runner');
  const expectedEvidenceRefs = fixture.provenance.slice(0, 64).map(source => `file:${source.path}#sha256=${source.sha256}`).sort();
  assert.deepEqual([...first.reuse.sharedNodeEvidence.evidenceRefs].sort(), expectedEvidenceRefs,
    'cross-task reuse lineage must preserve the deterministic 64-reference subset allowed by the graph-store schema while retaining the full provenance ledger in output');
  assert.equal(first.reuse.sharedNodeEvidence.verified, false, 'persisted source references are not independently verified claims');
  assert.equal(first.reuse.sharedNodeEvidence.usableForPlanning, false, 'source-reference presence cannot become planning authority');
  assert.match(first.reuse.sharedNodeEvidence.contentHash, /^[a-f0-9]{64}$/);
  assert.match(first.reuse.sharedNodeEvidence.provenanceHash, /^[a-f0-9]{64}$/);
  assert.equal(first.networkCalls, 0);
  assert.equal(first.modelCalls, 0);
  assert.equal(first.records.length, 50);
  assert.deepEqual(first.config.beamWidths, [1, 2, 4]);
});

test('compares single-path, topological ToT, and AGG beam widths on both tasks', () => {
  const output = run();
  const variants = new Set(output.summaries.map(row => row.variant));
  for (const variant of ['single-path:-', 'topological-tot:-', 'agg-beam:1', 'agg-beam:2', 'agg-beam:4']) assert.ok(variants.has(variant), `missing ${variant}`);
  assert.equal(output.reuse.taskCount, 2);
  assert.equal(output.reuse.iterations, 5);
  assert.equal(output.reuse.crossTaskReusedNodeCount, 1, 'the same stable capability key must be shared across both benchmark goals');
  assert.equal(output.reuse.reusedNodes[0].verified, false, 'cross-task reuse does not elevate unverified knowledge');
  assert.equal(output.reuse.reusedNodes[0].usableForPlanning, false, 'cross-task reuse alone does not satisfy execution readiness');
  assert.equal(output.tokenCost, null, 'without model calls token cost must be unknown/not applicable, not invented');
  assert.match(output.evidenceMetricNote, /does not mean source integrity/);
  assert.match(output.pruneMetricNote, /alternativesNotSelected is separate/);
  assert.ok(output.records.every(row => row.evidenceClaimsVerified === false), 'declared reference coverage cannot count as verified evidence');
  const topological = output.records.filter(row => row.method === 'topological-tot');
  assert.ok(topological.every(row => row.pruneCount === 0), 'full path enumeration does not count unselected alternatives as beam-pruned states');
  assert.ok(topological.some(row => row.alternativesNotSelected > 0), 'enumerated alternatives are reported separately from pruning');
  const widthOne = output.records.filter(row => row.method === 'agg-beam' && row.beamWidth === 1);
  const widthFour = output.records.filter(row => row.method === 'agg-beam' && row.beamWidth === 4);
  assert.equal(widthOne.length, 10);
  assert.equal(widthFour.length, 10);
  assert.ok(widthOne.some(row => row.pruneCount !== widthFour.find(other => other.taskId === row.taskId)?.pruneCount) ||
    widthOne.some(row => row.pathNodeIds.join(',') !== widthFour.find(other => other.taskId === row.taskId)?.pathNodeIds.join(',')),
  'fixture should expose at least one beam-width-dependent prune or selected path');
});

test('fixture contains competing branches, convergence, infeasible prerequisite, and gated recovery edge', () => {
  assert.equal(fixture.tasks.length, 2);
  for (const task of fixture.tasks) {
    assert.ok(task.edges.some(edge => edge.from === 'start' && edge.to === 'inspect-verifier'));
    assert.ok(task.edges.some(edge => edge.from === 'start' && edge.to === 'inspect-regression'));
    assert.ok(task.edges.some(edge => edge.to === 'infeasible-combined-check' && edge.type === 'requires_all'));
    assert.ok(task.edges.some(edge => edge.from === 'recovery-outcome-confirmed' && edge.to === 'blocked-check' && edge.type === 'requires_all'));
    assert.ok(task.edges.some(edge => edge.type === 'recovers_to' && edge.from === 'recovery-probe' && edge.to === 'recovery-outcome-confirmed'));
  }
  const paths = fixture.groundTruth.validGoalPaths;
  assert.equal(paths.length, 2, 'ground truth must define two competing goal paths');
  const pathValidFor = (task, ids) => ids.every((id, index) => index === 0 || task.edges.some(edge =>
    edge.from === ids[index - 1] && edge.to === id && ['next_step', 'enables', 'recovers_to'].includes(edge.type) &&
    (edge.type !== 'recovers_to' || task.recoveryOutcome === edge.condition?.onOutcome))) &&
    ids.every((id, index) => index === 0 || task.edges.filter(edge => edge.to === id && edge.type === 'requires_all').every(edge => ids.slice(0, index).includes(edge.from)));
  assert.ok(fixture.tasks.every(task => pathValidFor(task, paths[0])), 'nominal evidence branch must be valid for both tasks');
  assert.ok(pathValidFor(fixture.tasks[1], paths[1]), 'recovery branch must be valid when its outcome condition is met');
  assert.ok(!pathValidFor(fixture.tasks[0], paths[1]), 'recovery branch must be infeasible when outcome is unknown');
  const output = run();
  const unknownTaskRows = output.records.filter(row => row.taskId === 'task-verify-consistency' && row.method === 'agg-beam');
  const verifiedTaskRows = output.records.filter(row => row.taskId === 'task-verify-tamper-regression' && row.method === 'agg-beam');
  assert.ok(unknownTaskRows.every(row => !row.pathNodeIds.includes('recovery-outcome-confirmed')));
  assert.ok(verifiedTaskRows.every(row => !row.pathNodeIds.includes('recovery-outcome-confirmed')),
    'current AGG nominal-success API defers recovery edges even when fixture records the matching recovery outcome');
  assert.ok([...unknownTaskRows, ...verifiedTaskRows].every(row => row.deferredRecoveryEdges >= 1),
    'AGG should report deferred recovers_to edges rather than traverse them as nominal success');
  assert.ok(output.records.some(row => row.method === 'topological-tot' && row.taskId === 'task-verify-tamper-regression' && row.pathNodeIds.includes('recovery-outcome-confirmed')),
    'the deterministic baseline should include recovery path only when the fixture outcome gate is satisfied');
});

test('benchmark scores only paths declared by the fixture ground-truth oracle', () => {
  const workspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(workspace);
    // Inject a graph-valid but oracle-unsupported shortcut. A scorer that only
    // checks graph connectivity would award goal/path points to this route.
    for (const task of copy.tasks) task.edges.push({ from: task.startNodeId, to: task.goalNodeId, type: 'next_step' });
    saveFixture(workspace, copy);
    const result = runIsolated(workspace);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    const shortest = output.records.filter(row => row.method === 'topological-tot');
    assert.equal(shortest.length, 10);
    assert.ok(shortest.every(row => row.pathNodeIds.length === 2 && row.completed),
      'the injected shortcut must actually be selected so the regression exercises scoring, not just validation');
    assert.ok(shortest.every(row => row.groundTruthPathValid === false),
      'graph reachability must not substitute for the declared ground-truth oracle');
    assert.ok(shortest.every(row => row.evidenceCovered.length === 0 && row.declaredEvidenceReferenceCoverage === 0),
      'a shortcut that bypasses source inspection cannot claim the fixture evidence references');
    assert.ok(shortest.every(row => row.qualityScore <= 4),
      'oracle-invalid shortcuts must not earn the ground-truth path or evidence coverage points');
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('benchmark rejects stale per-task evidence requirements and out-of-scope evidence labels', () => {
  const staleWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(staleWorkspace);
    copy.tasks[0].requiredEvidence = ['verifier-implementation'];
    saveFixture(staleWorkspace, copy);
    const result = runIsolated(staleWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_TASK_CONTRACT_INVALID/);
  } finally { fs.rmSync(staleWorkspace, { recursive: true, force: true }); }

  const outOfScopeWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(outOfScopeWorkspace);
    copy.tasks[0].nodes.find(node => node.id === 'inspect-verifier').evidenceRefs.push('fabricated-independent-attestation');
    saveFixture(outOfScopeWorkspace, copy);
    const result = runIsolated(outOfScopeWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_EVIDENCE_REFERENCE_OUT_OF_SCOPE/);
  } finally { fs.rmSync(outOfScopeWorkspace, { recursive: true, force: true }); }
});

test('benchmark does not accept task-declared recovery outcome as ground truth', () => {
  const workspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(workspace);
    const task = copy.tasks[0];
    assert.equal(task.recoveryOutcome, 'unknown');
    assert.equal(task.edges.find(edge => edge.type === 'recovers_to')?.condition?.onOutcome, 'verification_failed');
    task.recoveryOutcome = 'verification_failed';
    saveFixture(workspace, copy);
    const result = runIsolated(workspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_TASK_RECOVERY_OUTCOME_MISMATCH/,
      'a self-declared result must not enable a recovery edge in the benchmark oracle');
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('benchmark pins task/node identities, causal edges, and the ground-truth oracle independently of graph connectivity', () => {
  const taskIdentityWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(taskIdentityWorkspace);
    copy.tasks[0].id = 'task-substituted-identity';
    saveFixture(taskIdentityWorkspace, copy);
    const result = runIsolated(taskIdentityWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_TASK_IDENTITY_MISMATCH/);
  } finally { fs.rmSync(taskIdentityWorkspace, { recursive: true, force: true }); }

  const edgeIdentityWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(edgeIdentityWorkspace);
    const edge = copy.tasks[0].edges.find(item => item.from === 'start' && item.to === 'inspect-verifier' && item.type === 'next_step');
    assert.ok(edge, 'fixture must contain the pinned verifier-inspection edge');
    edge.to = 'shortcut-guess';
    saveFixture(edgeIdentityWorkspace, copy);
    const result = runIsolated(edgeIdentityWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_GROUND_TRUTH_PATH_UNSATISFIABLE/);
  } finally { fs.rmSync(edgeIdentityWorkspace, { recursive: true, force: true }); }

  const oracleWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(oracleWorkspace);
    copy.tasks[0].edges.push(
      { from: 'start', to: 'shortcut-guess', type: 'next_step' },
      { from: 'shortcut-guess', to: 'report-investigation', type: 'next_step' }
    );
    copy.groundTruth.validGoalPaths[0] = ['start', 'shortcut-guess', 'report-investigation'];
    saveFixture(oracleWorkspace, copy);
    const result = runIsolated(oracleWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_FROZEN_ORACLE_MISMATCH/,
      'rewriting the oracle alongside a graph-valid shortcut must not authorize inflated scores');
  } finally { fs.rmSync(oracleWorkspace, { recursive: true, force: true }); }

  const rubricWorkspace = createIsolatedRunnerWorkspace();
  try {
    const copy = fixtureBytes(rubricWorkspace);
    copy.groundTruth.qualityRubric.validGroundTruthPath = 0;
    saveFixture(rubricWorkspace, copy);
    const result = runIsolated(rubricWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /BENCHMARK_FIXTURE_RUBRIC_INVALID/);
  } finally { fs.rmSync(rubricWorkspace, { recursive: true, force: true }); }
});

test('explicit output path is exclusive and never overwrites an existing file', () => {
  const target = path.join(root, '.test-tmp', `adaptive-goal-benchmark-existing-${process.pid}.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'preserve-me');
  try {
    const result = spawnSync(process.execPath, [runnerPath, '--output', target], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), 'preserve-me');
  } finally { fs.unlinkSync(target); }
});
