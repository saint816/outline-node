// 图片放大预览：点击任意预览图 → 全屏浮层，再点一次 / Esc 关闭。
// 纯渲染层，不改数据、不发消息；图片沿用已解析好的 src（同一条 CSP img-src 白名单）。

let overlay: HTMLElement | null = null;

export function isLightboxOpen(): boolean {
  return overlay !== null;
}

export function closeLightbox(): void {
  overlay?.remove();
  overlay = null;
}

export function openLightbox(src: string, alt: string): void {
  closeLightbox();
  const el = document.createElement('div');
  el.className = 'image-lightbox';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', alt);

  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  el.append(img);
  // 点浮层任意处（含图片本身）关闭；不 stopPropagation，符合 lightbox 直觉
  el.addEventListener('click', () => closeLightbox());
  document.body.append(el);
  overlay = el;
}

/** 委托安装：点击预览图放大。返回 true 表示这次点击被消费。 */
export function handleImageClick(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLImageElement) || !target.classList.contains('node-image')) {
    return false;
  }
  openLightbox(target.src, target.alt);
  return true;
}
