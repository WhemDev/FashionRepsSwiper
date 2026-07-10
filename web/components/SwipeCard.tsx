"use client";

import { useState } from "react";
import type { Item } from "@/lib/types";
import { proxied } from "@/lib/images";

const SWIPE_THRESHOLD = 80;

function brandColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 65%, 42%)`;
}

type Props = {
  item: Item;
  drag: { x: number; active: boolean };
  dragStartX: React.MutableRefObject<number>;
  onDrag: (drag: { x: number; active: boolean }) => void;
  onSwipe: (action: "save" | "skip") => void;
};

export default function SwipeCard({ item, drag, dragStartX, onDrag, onSwipe }: Props) {
  const rot = drag.x * 0.05;
  const stampOp = Math.min(Math.abs(drag.x) / SWIPE_THRESHOLD, 1);

  return (
    <article
      className={`card top ${drag.active ? "dragging" : ""}`}
      style={{
        transform: drag.active ? `translate(${drag.x}px, 0) rotate(${rot}deg)` : undefined,
        opacity: drag.active ? 1 : undefined,
      }}
      onPointerDown={(e) => {
        dragStartX.current = e.clientX;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onDrag({ x: 0, active: true });
      }}
      onPointerMove={(e) => {
        if (!drag.active) return;
        onDrag({ x: e.clientX - dragStartX.current, active: true });
      }}
      onPointerUp={(e) => {
        const dx = drag.active ? e.clientX - dragStartX.current : 0;
        if (Math.abs(dx) >= SWIPE_THRESHOLD) {
          onSwipe(dx > 0 ? "save" : "skip");
        } else {
          onDrag({ x: 0, active: false });
        }
      }}
      onPointerCancel={() => onDrag({ x: 0, active: false })}
    >
      <img
        className="card-img loaded"
        src={proxied(item.img, item.store)}
        alt=""
        draggable={false}
      />
      <div className="card-grad" />
      <div className="card-info">
        <span className="brand-chip" style={{ background: brandColor(item.brand) }}>
          {item.brand}
        </span>
        <h3 className="card-title">{item.title}</h3>
        <p className="card-store">{item.store}</p>
      </div>
      <div className="stamp stamp-save" style={{ opacity: drag.x > 0 ? stampOp : 0 }}>
        SAVE
      </div>
      <div className="stamp stamp-skip" style={{ opacity: drag.x < 0 ? stampOp : 0 }}>
        SKIP
      </div>
    </article>
  );
}
