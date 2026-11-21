let modulePromise;

function signature(hostname, timestamp) {
  let hash = BigInt("14695981039346656037");
  const prime = BigInt("1099511628211");
  const mask = BigInt("0xFFFFFFFFFFFFFFFF");

  function mix(text) {
    for (let i = 0; i < text.length; i++) {
      hash ^= BigInt(text.charCodeAt(i));
      hash = (hash * prime) & mask;
    }
  }

  mix("Meshy_Crypto_Key");
  mix(`${hostname}:${timestamp}`);
  hash ^= hash >> 33n;
  hash = (hash * BigInt("0xff51afd7ed558ccd")) & mask;
  hash ^= hash >> 33n;
  hash = (hash * BigInt("0xc4ceb9fe1a85ec53")) & mask;
  hash ^= hash >> 33n;
  return hash.toString(16).padStart(16, "0");
}

async function getMeshyModule() {
  if (!modulePromise) {
    modulePromise = import("./vendor/mesh_loader.js").catch((error) => {
      throw new Error(`Decoder files are missing or could not be loaded. Run setup-vendor.ps1, then reload the extension. Details: ${error.message}`);
    }).then(({ default: Module }) => Module({
      locateFile: (path) => new URL(`./vendor/${path}`, location.href).href,
      printErr: () => {},
    })).catch((error) => {
      if (String(error.message || error).includes("mesh_loader.wasm")) {
        throw new Error(`Decoder files are missing or could not be loaded. Run setup-vendor.ps1, then reload the extension. Details: ${error.message}`);
      }
      throw error;
    }).then((mod) => {
      const hostname = "www.meshy.ai";
      const timestamp = Date.now();
      if (!mod.authorize(hostname, timestamp, signature(hostname, timestamp))) {
        throw new Error("Could not authorize the Meshy decoder.");
      }
      return mod;
    });
  }
  return modulePromise;
}

const readers = {
  5120: { size: 1, read: (b, o) => b.getInt8(o) },
  5121: { size: 1, read: (b, o) => b.getUint8(o) },
  5122: { size: 2, read: (b, o) => b.getInt16(o, true) },
  5123: { size: 2, read: (b, o) => b.getUint16(o, true) },
  5125: { size: 4, read: (b, o) => b.getUint32(o, true) },
  5126: { size: 4, read: (b, o) => b.getFloat32(o, true) },
};

const typeCounts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function readGlb(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (new TextDecoder().decode(bytes.slice(0, 4)) !== "glTF" || view.getUint32(4, true) !== 2) {
    throw new Error("The decoder did not return a valid GLB.");
  }

  let offset = 12;
  let json;
  let bin;
  while (offset < bytes.length) {
    const length = view.getUint32(offset, true);
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    const chunk = bytes.slice(offset + 8, offset + 8 + length);
    if (type === "JSON") json = JSON.parse(new TextDecoder().decode(chunk));
    if (type === "BIN\0") bin = chunk;
    offset += 8 + length;
  }
  if (!json || !bin) throw new Error("GLB is missing JSON/BIN chunks.");
  return { json, bin };
}

function normalized(value, componentType) {
  if (componentType === 5120) return Math.max(value / 127, -1);
  if (componentType === 5121) return value / 255;
  if (componentType === 5122) return Math.max(value / 32767, -1);
  if (componentType === 5123) return value / 65535;
  return value;
}

function accessorReader(gltf, bin, index) {
  const accessor = gltf.accessors[index];
  const bufferView = gltf.bufferViews[accessor.bufferView];
  const reader = readers[accessor.componentType];
  const itemSize = typeCounts[accessor.type];
  if (!reader || !itemSize) throw new Error(`Unsupported GLB accessor: ${index}`);

  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const stride = bufferView.byteStride || reader.size * itemSize;
  const start = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);

  return {
    count: accessor.count,
    get(item) {
      const values = [];
      const base = start + item * stride;
      for (let i = 0; i < itemSize; i++) {
        let value = reader.read(view, base + i * reader.size);
        if (accessor.normalized) value = normalized(value, accessor.componentType);
        values.push(value);
      }
      return values;
    },
  };
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      for (let k = 0; k < 4; k++) out[row * 4 + col] += a[row * 4 + k] * b[k * 4 + col];
    }
  }
  return out;
}

function matrixFromNode(node) {
  if (node.matrix) return node.matrix;
  const t = node.translation || [0, 0, 0];
  const s = node.scale || [1, 1, 1];
  const q = node.rotation || [0, 0, 0, 1];
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - yy - zz) * s[0], (xy - wz) * s[1], (xz + wy) * s[2], t[0],
    (xy + wz) * s[0], (1 - xx - zz) * s[1], (yz - wx) * s[2], t[1],
    (xz - wy) * s[0], (yz + wx) * s[1], (1 - xx - yy) * s[2], t[2],
    0, 0, 0, 1,
  ];
}

function transform(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function collectMeshNodes(gltf) {
  const scene = gltf.scenes[gltf.scene || 0];
  const nodes = [];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  function visit(index, parent) {
    const node = gltf.nodes[index];
    const world = multiply(parent, matrixFromNode(node));
    if (node.mesh !== undefined) nodes.push({ node, world });
    for (const child of node.children || []) visit(child, world);
  }

  for (const index of scene.nodes || []) visit(index, identity);
  return nodes;
}

function glbToBinaryStl(buffer) {
  const { json, bin } = readGlb(buffer);
  const meshNodes = collectMeshNodes(json);
  let triangleCount = 0;

  for (const { node } of meshNodes) {
    const mesh = json.meshes[node.mesh];
    for (const primitive of mesh.primitives || []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      if (primitive.attributes?.POSITION === undefined) throw new Error("GLB is missing POSITION.");
      const indices = primitive.indices === undefined ? null : accessorReader(json, bin, primitive.indices);
      const positions = accessorReader(json, bin, primitive.attributes.POSITION);
      triangleCount += Math.floor((indices ? indices.count : positions.count) / 3);
    }
  }

  const out = new ArrayBuffer(84 + triangleCount * 50);
  const bytes = new Uint8Array(out);
  const view = new DataView(out);
  bytes.set(new TextEncoder().encode("Converted from model GLB"));
  view.setUint32(80, triangleCount, true);

  let offset = 84;
  function writeVector(v) {
    view.setFloat32(offset, v[0], true); offset += 4;
    view.setFloat32(offset, v[1], true); offset += 4;
    view.setFloat32(offset, v[2], true); offset += 4;
  }

  for (const { node, world } of meshNodes) {
    const mesh = json.meshes[node.mesh];
    for (const primitive of mesh.primitives || []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      const positions = accessorReader(json, bin, primitive.attributes.POSITION);
      const indices = primitive.indices === undefined ? null : accessorReader(json, bin, primitive.indices);
      const count = indices ? indices.count : positions.count;

      for (let i = 0; i + 2 < count; i += 3) {
        const ia = indices ? indices.get(i)[0] : i;
        const ib = indices ? indices.get(i + 1)[0] : i + 1;
        const ic = indices ? indices.get(i + 2)[0] : i + 2;
        const a = transform(world, positions.get(ia));
        const b = transform(world, positions.get(ib));
        const c = transform(world, positions.get(ic));
        writeVector(faceNormal(a, b, c));
        writeVector(a);
        writeVector(b);
        writeVector(c);
        view.setUint16(offset, 0, true);
        offset += 2;
      }
    }
  }

  return out;
}

function safeFileName(value, fallback) {
  return String(value || fallback).replace(/[^a-z0-9_.-]+/gi, "_").replace(/^\.+|\.+$/g, "") || fallback;
}

function bytesFromDataUri(uri) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(uri || "");
  if (!match) return null;
  const payload = decodeURIComponent(match[3]);
  if (match[2]) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mimeType: match[1] || "application/octet-stream" };
  }
  return { bytes: new TextEncoder().encode(payload), mimeType: match[1] || "application/octet-stream" };
}

function imageExtension(mimeType) {
  if (/jpeg/i.test(mimeType)) return "jpg";
  if (/webp/i.test(mimeType)) return "webp";
  return "png";
}

function embeddedTextures(json, bin) {
  const files = [];
  const names = [];
  for (let index = 0; index < (json.images || []).length; index++) {
    const image = json.images[index];
    let bytes = null;
    let mimeType = image.mimeType || "application/octet-stream";
    if (image.bufferView !== undefined) {
      const view = json.bufferViews[image.bufferView];
      bytes = bin.slice(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
    } else if (image.uri?.startsWith("data:")) {
      const decoded = bytesFromDataUri(image.uri);
      if (decoded) { bytes = decoded.bytes; mimeType = decoded.mimeType; }
    }
    if (!bytes) continue;
    const name = `${safeFileName(image.name, `texture_${index + 1}`)}.${imageExtension(mimeType)}`;
    names[index] = name;
    files.push({ name, buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mimeType });
  }
  return { files, names };
}

function glbToObjPackage(buffer, baseName = "model") {
  const { json, bin } = readGlb(buffer);
  const meshNodes = collectMeshNodes(json);
  const textures = embeddedTextures(json, bin);
  const base = safeFileName(baseName, "model");
  const objLines = ["# Converted from model GLB", `mtllib ${base}.mtl`];
  const mtlLines = ["# Materials converted from model GLB"];
  let vertexOffset = 0;
  let uvOffset = 0;
  let objectIndex = 0;

  (json.materials || []).forEach((material, index) => {
    const name = safeFileName(material.name, `material_${index + 1}`);
    const pbr = material.pbrMetallicRoughness || {};
    const color = pbr.baseColorFactor || [1, 1, 1, 1];
    mtlLines.push(`newmtl ${name}`, `Kd ${color[0]} ${color[1]} ${color[2]}`, "Ka 0 0 0", "Ks 0 0 0", "d 1", "illum 2");
    const textureIndex = pbr.baseColorTexture?.index;
    const imageIndex = textureIndex === undefined ? undefined : json.textures?.[textureIndex]?.source;
    if (imageIndex !== undefined && textures.names[imageIndex]) mtlLines.push(`map_Kd ${textures.names[imageIndex]}`);
    mtlLines.push("");
  });

  for (const { node, world } of meshNodes) {
    const mesh = json.meshes[node.mesh];
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives || []).length; primitiveIndex++) {
      const primitive = mesh.primitives[primitiveIndex];
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      if (primitive.attributes?.POSITION === undefined) throw new Error("GLB is missing POSITION.");

      const positions = accessorReader(json, bin, primitive.attributes.POSITION);
      const indices = primitive.indices === undefined ? null : accessorReader(json, bin, primitive.indices);
      const objectName = String(mesh.name || node.name || `mesh_${objectIndex + 1}`)
        .replace(/[^a-z0-9_.-]+/gi, "_");
      objLines.push(`o ${objectName}_${primitiveIndex + 1}`);
      if (primitive.material !== undefined) objLines.push(`usemtl ${safeFileName(json.materials?.[primitive.material]?.name, `material_${primitive.material + 1}`)}`);

      const texcoords = primitive.attributes.TEXCOORD_0 === undefined ? null : accessorReader(json, bin, primitive.attributes.TEXCOORD_0);

      for (let i = 0; i < positions.count; i++) {
        const point = transform(world, positions.get(i));
        objLines.push(`v ${point[0]} ${point[1]} ${point[2]}`);
        if (texcoords && i < texcoords.count) {
          const uv = texcoords.get(i);
          objLines.push(`vt ${uv[0]} ${1 - uv[1]}`);
        }
      }

      const count = indices ? indices.count : positions.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const a = (indices ? indices.get(i)[0] : i) + vertexOffset + 1;
        const b = (indices ? indices.get(i + 1)[0] : i + 1) + vertexOffset + 1;
        const c = (indices ? indices.get(i + 2)[0] : i + 2) + vertexOffset + 1;
        if (texcoords) objLines.push(`f ${a}/${a + uvOffset} ${b}/${b + uvOffset} ${c}/${c + uvOffset}`);
        else objLines.push(`f ${a} ${b} ${c}`);
      }

      vertexOffset += positions.count;
      if (texcoords) uvOffset += texcoords.count;
      objectIndex++;
    }
  }

  if (!objectIndex) throw new Error("GLB does not contain triangle meshes.");
  const files = [
    { name: `${base}.obj`, buffer: new TextEncoder().encode(`${objLines.join("\n")}\n`).buffer, mimeType: "text/plain" },
    { name: `${base}.mtl`, buffer: new TextEncoder().encode(`${mtlLines.join("\n")}\n`).buffer, mimeType: "text/plain" },
    ...textures.files,
  ];
  return { files };
}

function glbToObj(buffer) {
  return glbToObjPackage(buffer).files[0].buffer;
}

async function convert(buffer, format, baseName = "model") {
  const bytes = new Uint8Array(buffer);
  const isGlb = bytes.length >= 4 && new TextDecoder().decode(bytes.slice(0, 4)) === "glTF";
  let glb = buffer;
  if (!isGlb) {
    const mod = await getMeshyModule();
    const result = mod.processMeshyFile(bytes);
    if (!result?.success) throw new Error(result?.error || "Failed to decode .meshy.");
    glb = result.data instanceof Uint8Array ? result.data.buffer.slice(result.data.byteOffset, result.data.byteOffset + result.data.byteLength) : result.data;
  }
  if (format === "glb") return glb;
  if (format === "obj-package") return glbToObjPackage(glb, baseName);
  if (format === "obj") return glbToObj(glb);
  if (format === "stl") return glbToBinaryStl(glb);
  throw new Error(`Unsupported output format: ${format}`);
}

window.addEventListener("message", async (event) => {
  if (event.data?.type !== "convert") return;
  try {
    const output = await convert(event.data.buffer, event.data.format, event.data.baseName);
    const transfer = output?.files ? output.files.map((file) => file.buffer) : [output];
    event.source.postMessage({ id: event.data.id, ok: true, output }, event.origin, transfer);
  } catch (error) {
    event.source.postMessage({ id: event.data.id, ok: false, error: error.message }, event.origin);
  }
});
