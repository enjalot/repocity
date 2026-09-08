import * as THREE from 'three'
import type { CityDistrict } from './model'

/** Pack labels into shared textures and draws; suppress subpixel text when zoomed out. */
export function districtLabels(districts: CityDistrict[], scale: number, worldWidth: number, worldHeight: number) {
  const batches: THREE.InstancedMesh[] = []
  const pixelsPerUnit = { value: 1 }
  const cellWidth = 512
  const cellHeight = 64
  const columns = 4
  const pageSize = 128
  for (let start = 0; start < districts.length; start += pageSize) {
    const page = districts.slice(start, start + pageSize)
    const canvas = document.createElement('canvas')
    canvas.width = cellWidth * columns
    canvas.height = cellHeight * Math.ceil(page.length / columns)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create district label texture')
    context.font = '500 32px system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillStyle = '#ffffff'
    context.strokeStyle = 'rgba(8, 12, 22, 0.9)'
    context.lineWidth = 5
    const rects = new Float32Array(page.length * 4)
    const glyphHeights = new Float32Array(page.length)
    const geometry = new THREE.PlaneGeometry(1, 1)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.MeshBasicMaterial({
      map: texture, transparent: true, alphaTest: 0.04, depthTest: false,
      depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false,
    })
    material.onBeforeCompile = (shader) => {
      shader.uniforms.labelPixelsPerUnit = pixelsPerUnit
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 labelRect;
          attribute float glyphHeight;
          uniform float labelPixelsPerUnit;
          varying float labelOpacity;`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          vMapUv = labelRect.xy + vMapUv * labelRect.zw;
          labelOpacity = smoothstep(7.0, 11.0, glyphHeight * labelPixelsPerUnit);`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float labelOpacity;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= labelOpacity;')
    }
    material.customProgramCacheKey = () => 'district-atlas-v1'
    const mesh = new THREE.InstancedMesh(geometry, material, page.length)
    const dummy = new THREE.Object3D()
    page.forEach((district, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      let text = district.name
      while (context.measureText(text).width > cellWidth - 32 && text.length > 3) {
        text = `…${text.slice(text.startsWith('…') ? 2 : 1)}`
      }
      const x = column * cellWidth + cellWidth / 2
      const y = row * cellHeight + cellHeight / 2
      context.strokeText(text, x, y)
      context.fillText(text, x, y)
      rects.set([column / columns, 1 - (row + 1) * cellHeight / canvas.height,
        1 / columns, cellHeight / canvas.height], index * 4)
      const width = Math.min(12, (district.x1 - district.x0) * scale * 0.88)
      glyphHeights[index] = width * 32 / cellWidth
      dummy.position.set(
        ((district.x0 + district.x1) / 2 - worldWidth / 2) * scale,
        0.13, (district.y1 - 4.5 - worldHeight / 2) * scale,
      )
      dummy.rotation.x = -Math.PI / 2
      dummy.scale.set(width, width * cellHeight / cellWidth, 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(index, dummy.matrix)
    })
    geometry.setAttribute('labelRect', new THREE.InstancedBufferAttribute(rects, 4))
    geometry.setAttribute('glyphHeight', new THREE.InstancedBufferAttribute(glyphHeights, 1))
    mesh.name = 'district-labels'
    mesh.frustumCulled = false
    mesh.renderOrder = 9
    batches.push(mesh)
  }
  return { batches, pixelsPerUnit }
}
