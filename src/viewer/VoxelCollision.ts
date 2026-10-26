/**
 * Sparse voxel collision field for a 3DGS reconstruction.
 *
 * Vendored verbatim from the official Aholo walk demo
 * (`docs/research/spec/gh/ex-walk-demo.ts`, lines 50-52 and 57-454), which is
 * MIT licensed and itself derived from SuperSplat Viewer (MIT).
 *
 * Splats carry no geometry, so a reconstructed room is see-through and has no
 * collision of its own. Aholo ships a separate occupancy field alongside the
 * scan (a sparse octree: `collision.voxel-meta.json` + `collision.voxel.bin`)
 * and this is the code that reads it.
 *
 * Copied by line range rather than retyped, so the bit-twiddling in
 * `isVoxelSolid` and the DDA in `queryRay` are exactly upstream's.
 *
 * Do not reformat: keeping this byte-identical to upstream is what makes a
 * future re-vendor a diff instead of a review.
 */

const SOLID_LEAF_MARKER = 0xff000000 >>> 0;
const PENETRATION_EPSILON = 1e-4;
const MAX_RESOLVE_ITERATIONS = 4;

export class VoxelCollision {
    private gridMinX: number;
    private gridMinY: number;
    private gridMinZ: number;
    private voxelCountX: number;
    private voxelCountY: number;
    private voxelCountZ: number;
    private voxelSize: number;
    private leafSize: number;
    private treeDepth: number;
    private nodes: Uint32Array;
    private leafData: Uint32Array;
    private scratchPush: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
    private contactNormals: { x: number; y: number; z: number }[] = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
    ];

    constructor(
        metadata: {
            gridBounds: { min: number[]; max: number[] };
            voxelResolution: number;
            leafSize: number;
            treeDepth: number;
        },
        nodes: Uint32Array,
        leafData: Uint32Array,
    ) {
        this.gridMinX = metadata.gridBounds.min[0];
        this.gridMinY = metadata.gridBounds.min[1];
        this.gridMinZ = metadata.gridBounds.min[2];
        const voxelSize = metadata.voxelResolution;
        this.voxelCountX = Math.round((metadata.gridBounds.max[0] - metadata.gridBounds.min[0]) / voxelSize);
        this.voxelCountY = Math.round((metadata.gridBounds.max[1] - metadata.gridBounds.min[1]) / voxelSize);
        this.voxelCountZ = Math.round((metadata.gridBounds.max[2] - metadata.gridBounds.min[2]) / voxelSize);
        this.voxelSize = voxelSize;
        this.leafSize = metadata.leafSize;
        this.treeDepth = metadata.treeDepth;
        this.nodes = nodes;
        this.leafData = leafData;
    }

    /** Fast point occupancy lookup. */
    isVoxelSolid(ix: number, iy: number, iz: number): boolean {
        if (
            this.nodes.length === 0 ||
            ix < 0 ||
            iy < 0 ||
            iz < 0 ||
            ix >= this.voxelCountX ||
            iy >= this.voxelCountY ||
            iz >= this.voxelCountZ
        ) {
            return false;
        }
        const blockX = Math.floor(ix / this.leafSize);
        const blockY = Math.floor(iy / this.leafSize);
        const blockZ = Math.floor(iz / this.leafSize);
        let nodeIndex = 0;
        for (let level = this.treeDepth - 1; level >= 0; level--) {
            const node = this.nodes[nodeIndex] >>> 0;
            if (node === SOLID_LEAF_MARKER) {
                return true;
            }
            const childMask = (node >>> 24) & 0xff;
            if (childMask === 0) {
                return this.checkLeafByIndex(node, ix, iy, iz);
            }
            const bitX = (blockX >>> level) & 1;
            const bitY = (blockY >>> level) & 1;
            const bitZ = (blockZ >>> level) & 1;
            const octant = (bitZ << 2) | (bitY << 1) | bitX;
            if ((childMask & (1 << octant)) === 0) {
                return false;
            }
            const baseOffset = node & 0x00ffffff;
            const prefix = (1 << octant) - 1;
            nodeIndex = baseOffset + popcount(childMask & prefix);
        }
        const node = this.nodes[nodeIndex] >>> 0;
        if (node === SOLID_LEAF_MARKER) {
            return true;
        }
        return this.checkLeafByIndex(node, ix, iy, iz);
    }

    /** Raycast through voxels for ground snaps and camera blocking checks. */
    queryRay(
        ox: number,
        oy: number,
        oz: number,
        dx: number,
        dy: number,
        dz: number,
        maxDist: number,
    ): { x: number; y: number; z: number } | null {
        if (this.nodes.length === 0) {
            return null;
        }
        const voxelSize = this.voxelSize;
        const gMinX = this.gridMinX;
        const gMinY = this.gridMinY;
        const gMinZ = this.gridMinZ;
        const gMaxX = gMinX + this.voxelCountX * voxelSize;
        const gMaxY = gMinY + this.voxelCountY * voxelSize;
        const gMaxZ = gMinZ + this.voxelCountZ * voxelSize;
        const EPS = 1e-12;

        let tNear = 0;
        let tFar = maxDist;
        const slab = (o: number, d: number, min: number, max: number) => {
            if (Math.abs(d) <= EPS) {
                return o >= min && o < max;
            }
            let t1 = (min - o) / d;
            let t2 = (max - o) / d;
            if (t1 > t2) {
                const tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > tNear) {
                tNear = t1;
            }
            tFar = Math.min(tFar, t2);
            return tNear <= tFar;
        };
        if (!slab(ox, dx, gMinX, gMaxX) || !slab(oy, dy, gMinY, gMaxY) || !slab(oz, dz, gMinZ, gMaxZ)) {
            return null;
        }
        const entryX = ox + dx * tNear;
        const entryY = oy + dy * tNear;
        const entryZ = oz + dz * tNear;
        let ix = Math.max(0, Math.min(Math.floor((entryX - gMinX) / voxelSize), this.voxelCountX - 1));
        let iy = Math.max(0, Math.min(Math.floor((entryY - gMinY) / voxelSize), this.voxelCountY - 1));
        let iz = Math.max(0, Math.min(Math.floor((entryZ - gMinZ) / voxelSize), this.voxelCountZ - 1));

        const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
        const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
        const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
        const invDx = Math.abs(dx) > EPS ? 1 / dx : 0;
        const invDy = Math.abs(dy) > EPS ? 1 / dy : 0;
        const invDz = Math.abs(dz) > EPS ? 1 / dz : 0;
        let tMaxX = Math.abs(dx) > EPS ? (gMinX + (ix + (dx > 0 ? 1 : 0)) * voxelSize - ox) * invDx : Infinity;
        let tMaxY = Math.abs(dy) > EPS ? (gMinY + (iy + (dy > 0 ? 1 : 0)) * voxelSize - oy) * invDy : Infinity;
        let tMaxZ = Math.abs(dz) > EPS ? (gMinZ + (iz + (dz > 0 ? 1 : 0)) * voxelSize - oz) * invDz : Infinity;
        const tDeltaX = Math.abs(dx) > EPS ? voxelSize * Math.abs(invDx) : Infinity;
        const tDeltaY = Math.abs(dy) > EPS ? voxelSize * Math.abs(invDy) : Infinity;
        const tDeltaZ = Math.abs(dz) > EPS ? voxelSize * Math.abs(invDz) : Infinity;
        let currentT = tNear;

        const maxSteps = this.voxelCountX + this.voxelCountY + this.voxelCountZ;
        for (let i = 0; i < maxSteps; i++) {
            if (this.isVoxelSolid(ix, iy, iz)) {
                return { x: ox + dx * currentT, y: oy + dy * currentT, z: oz + dz * currentT };
            }
            if (tMaxX < tMaxY) {
                if (tMaxX < tMaxZ) {
                    currentT = tMaxX;
                    ix += stepX;
                    tMaxX += tDeltaX;
                } else {
                    currentT = tMaxZ;
                    iz += stepZ;
                    tMaxZ += tDeltaZ;
                }
            } else if (tMaxY < tMaxZ) {
                currentT = tMaxY;
                iy += stepY;
                tMaxY += tDeltaY;
            } else {
                currentT = tMaxZ;
                iz += stepZ;
                tMaxZ += tDeltaZ;
            }
            if (
                ix < 0 ||
                iy < 0 ||
                iz < 0 ||
                ix >= this.voxelCountX ||
                iy >= this.voxelCountY ||
                iz >= this.voxelCountZ ||
                currentT > maxDist
            ) {
                return null;
            }
        }
        return null;
    }

    /** Resolve a vertical capsule out of solid voxels. */
    queryCapsule(
        cx: number,
        cy: number,
        cz: number,
        halfHeight: number,
        radius: number,
        out: { x: number; y: number; z: number },
    ): boolean {
        return this.resolveIterative(
            cx,
            cy,
            cz,
            (rx, ry, rz, push) => this.resolveDeepestPenetrationCapsule(rx, ry, rz, halfHeight, radius, push),
            out,
        );
    }

    /** Read one packed leaf bit. */
    private checkLeafByIndex(node: number, ix: number, iy: number, iz: number) {
        const leafDataIndex = node & 0x00ffffff;
        const vx = ix & 3;
        const vy = iy & 3;
        const vz = iz & 3;
        const bitIndex = vz * 16 + vy * 4 + vx;
        if (bitIndex < 32) {
            const lo = this.leafData[leafDataIndex * 2] >>> 0;
            return ((lo >>> bitIndex) & 1) === 1;
        }
        const hi = this.leafData[leafDataIndex * 2 + 1] >>> 0;
        return ((hi >>> (bitIndex - 32)) & 1) === 1;
    }

    /** Find the strongest push needed to move a capsule out of nearby solid voxels. */
    private resolveDeepestPenetrationCapsule(
        cx: number,
        cy: number,
        cz: number,
        halfHeight: number,
        radius: number,
        out: { x: number; y: number; z: number },
    ): boolean {
        const voxelSize = this.voxelSize;
        const radiusSq = radius * radius;
        const segBottomY = cy - halfHeight;
        const segTopY = cy + halfHeight;
        const ixMin = Math.floor((cx - radius - this.gridMinX) / voxelSize);
        const iyMin = Math.floor((segBottomY - radius - this.gridMinY) / voxelSize);
        const izMin = Math.floor((cz - radius - this.gridMinZ) / voxelSize);
        const ixMax = Math.floor((cx + radius - this.gridMinX) / voxelSize);
        const iyMax = Math.floor((segTopY + radius - this.gridMinY) / voxelSize);
        const izMax = Math.floor((cz + radius - this.gridMinZ) / voxelSize);
        let bestPushX = 0;
        let bestPushY = 0;
        let bestPushZ = 0;
        let bestPen = PENETRATION_EPSILON;
        let found = false;

        for (let iz = izMin; iz <= izMax; iz++) {
            for (let iy = iyMin; iy <= iyMax; iy++) {
                for (let ix = ixMin; ix <= ixMax; ix++) {
                    if (!this.isVoxelSolid(ix, iy, iz)) {
                        continue;
                    }
                    const vMinX = this.gridMinX + ix * voxelSize;
                    const vMinY = this.gridMinY + iy * voxelSize;
                    const vMinZ = this.gridMinZ + iz * voxelSize;
                    const vMaxX = vMinX + voxelSize;
                    const vMaxY = vMinY + voxelSize;
                    const vMaxZ = vMinZ + voxelSize;
                    let segY: number;
                    if (segTopY < vMinY) {
                        segY = segTopY;
                    } else if (segBottomY > vMaxY) {
                        segY = segBottomY;
                    } else {
                        segY = Math.max(segBottomY, Math.min(segTopY, (vMinY + vMaxY) * 0.5));
                    }
                    const nearX = Math.max(vMinX, Math.min(cx, vMaxX));
                    const nearY = Math.max(vMinY, Math.min(segY, vMaxY));
                    const nearZ = Math.max(vMinZ, Math.min(cz, vMaxZ));
                    const dx = cx - nearX;
                    const dy = segY - nearY;
                    const dz = cz - nearZ;
                    const distSq = dx * dx + dy * dy + dz * dz;
                    if (distSq >= radiusSq) {
                        continue;
                    }
                    let px = 0;
                    let py = 0;
                    let pz = 0;
                    let penetration: number;
                    if (distSq > 1e-12) {
                        const dist = Math.sqrt(distSq);
                        penetration = radius - dist;
                        const invDist = 1 / dist;
                        px = dx * invDist * penetration;
                        py = dy * invDist * penetration;
                        pz = dz * invDist * penetration;
                    } else {
                        const escapeX = Math.min(cx - vMinX, vMaxX - cx) + radius;
                        const escapeY = Math.min(segY - vMinY, vMaxY - segY) + radius;
                        const escapeZ = Math.min(cz - vMinZ, vMaxZ - cz) + radius;
                        if (escapeX <= escapeY && escapeX <= escapeZ) {
                            px = cx - vMinX < vMaxX - cx ? -escapeX : escapeX;
                            penetration = escapeX;
                        } else if (escapeY <= escapeZ) {
                            py = segY - vMinY < vMaxY - segY ? -escapeY : escapeY;
                            penetration = escapeY;
                        } else {
                            pz = cz - vMinZ < vMaxZ - cz ? -escapeZ : escapeZ;
                            penetration = escapeZ;
                        }
                    }
                    if (penetration > bestPen) {
                        bestPen = penetration;
                        bestPushX = px;
                        bestPushY = py;
                        bestPushZ = pz;
                        found = true;
                    }
                }
            }
        }
        if (found) {
            out.x = bestPushX;
            out.y = bestPushY;
            out.z = bestPushZ;
        }
        return found;
    }

    /** Apply a few push-out passes so corner collisions do not trap the capsule. */
    private resolveIterative(
        cx: number,
        cy: number,
        cz: number,
        findPenetration: (x: number, y: number, z: number, out: { x: number; y: number; z: number }) => boolean,
        out: { x: number; y: number; z: number },
    ): boolean {
        let resolvedX = cx;
        let resolvedY = cy;
        let resolvedZ = cz;
        let totalPushX = 0;
        let totalPushY = 0;
        let totalPushZ = 0;
        let hadCollision = false;
        let numNormals = 0;

        for (let iter = 0; iter < MAX_RESOLVE_ITERATIONS; iter++) {
            if (!findPenetration(resolvedX, resolvedY, resolvedZ, this.scratchPush)) {
                break;
            }
            hadCollision = true;
            let px = this.scratchPush.x;
            let py = this.scratchPush.y;
            let pz = this.scratchPush.z;

            for (let i = 0; i < numNormals; i++) {
                const n = this.contactNormals[i];
                const dot = px * n.x + py * n.y + pz * n.z;
                if (dot < 0) {
                    px -= dot * n.x;
                    py -= dot * n.y;
                    pz -= dot * n.z;
                }
            }

            const len = Math.sqrt(
                this.scratchPush.x * this.scratchPush.x +
                    this.scratchPush.y * this.scratchPush.y +
                    this.scratchPush.z * this.scratchPush.z,
            );
            if (len > PENETRATION_EPSILON && numNormals < 3) {
                const invLen = 1 / len;
                const n = this.contactNormals[numNormals];
                n.x = this.scratchPush.x * invLen;
                n.y = this.scratchPush.y * invLen;
                n.z = this.scratchPush.z * invLen;
                numNormals++;
            }

            resolvedX += px;
            resolvedY += py;
            resolvedZ += pz;
            totalPushX += px;
            totalPushY += py;
            totalPushZ += pz;
        }

        const totalPushSq = totalPushX * totalPushX + totalPushY * totalPushY + totalPushZ * totalPushZ;
        const hasSignificantPush = hadCollision && totalPushSq > PENETRATION_EPSILON * PENETRATION_EPSILON;
        if (hasSignificantPush) {
            out.x = totalPushX;
            out.y = totalPushY;
            out.z = totalPushZ;
        }
        return hasSignificantPush;
    }
}

const popcount = (n: number) => {
    n >>>= 0;
    n -= (n >>> 1) & 0x55555555;
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
