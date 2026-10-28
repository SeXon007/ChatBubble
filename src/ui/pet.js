(async () => {
    'use strict';
    // Shared silhouette and spring timing from the user-approved prototype.
    // This adapter owns desktop coordinates and animation only; renderer.ts owns real chat and drafts.
    const host = window.desktop;
    let stage = await host.getDesktopScene(), areas = [], composerHeight = 42, messageHeight = 380, lastRegions = '', lastRegionRects = [];
    const optionKeys = { enabled: 'petEnabled', distance: 'petDistance', size: 'petSize', eyeSize: 'petEyeSize', motion: 'petMotion', gaze: 'petGaze', life: 'petLife', width: 'petWidth', color: 'petColor', viscosity: 'petViscosity' };
    const root = document.getElementById('cb-pet-inline'), $ = id => root.querySelector('#' + id);
    const screen = $('cb-desktop'), pet = $('cb-pet'), chat = $('chat'), form = $('composer');
    const config = Object.fromEntries(Object.entries(optionKeys).map(([key, field]) => [key, stage.options[field]]));
    const eyeScale = .86;
    const dockShape = { height: 1.7, spread: 1.18 };
    const expressionPreview = { expression: 'auto' };
    const profiles = { crisp: { k: 380, d: 29, m: 16, pull: 42 }, lively: { k: 290, d: 17, m: 13, pull: 53 }, sticky: { k: 190, d: 16, m: 9, pull: 70 } };
    const edges = ['left', 'right', 'top', 'bottom'], edgeNames = { left: '左侧', right: '右侧', top: '顶部', bottom: '底部' };
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), lerp = (a, b, t) => a + (b - a) * t, smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
    // The eyes track the cursor within roughly half the current screen; beyond that they return to centre,
    // stop waking the face, and the normal idle/rest clock takes over.
    const followRadius = () => Math.max(activeArea().width, activeArea().height) * .5;
    function nearPet(x, y) { return Math.hypot(x - S.x, y - S.y) <= followRadius(); }
    const S = { x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0, side: null, shapeSide: 'right', blocked: null, blend: 0, contact: 0, press: 0, flow: null, mode: 'idle', candidate: null, drag: null, demo: null, pull: 0, hidden: false, hover: false, seen: false, pointerSeen: false, lookX: 0, lookY: 0, gazeX: 0, gazeY: 0, gazeVX: 0, gazeVY: 0, wantsOpen: false, morph: 0, morphV: 0, impulse: 0, phase: 0, focusPending: false, returnFocus: false, sendPulse: 0, origin: null };
    S.face = { kind: 'idle', action: '', drag: 0, land: 0, rest: 0, lastActive: performance.now(), blinkAt: performance.now() + 4200, blinkCount: 0, dragAt: -Infinity, settleAt: -Infinity, settlePending: false, curiousArmed: false, peekStarted: -Infinity, lastPeekAt: -Infinity, peekCount: 0, peekDirection: 1 };
    let W = 0, H = 0, scale = .68, last = performance.now(), lastStatus = '', restored = null;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    let reduce = media.matches;
    media.addEventListener('change', e => reduce = e.matches);
    const darkMedia = matchMedia('(prefers-color-scheme: dark)');
    let dark = darkMedia.matches;
    darkMedia.addEventListener('change', e => dark = e.matches);
    function persist() { void host.savePetPosition({ x: S.tx + stage.bounds.x, y: S.ty + stage.bounds.y, side: S.side, displayId: S.display }).catch(() => { }); }
    function activeArea() { return areas.find(a => a.id === S.display) || areas[0]; }
    let leftPaint = null;
    function clearLeftPaint() {
        if (!leftPaint) return;
        leftPaint = null; lastRegions = '';
        if (lastRegionRects.length) void host.setRegions(lastRegionRects, false, []).catch(() => {});
    }
    function reserveLeftPaint() {
        const padding = 80 * scale + 24, minX = Math.max(0, Math.min(S.x, S.tx) - padding), minY = Math.max(0, Math.min(S.y, S.ty) - padding),
            maxX = Math.min(W, Math.max(S.x, S.tx) + padding), maxY = Math.min(H, Math.max(S.y, S.ty) + padding), old = leftPaint?.[0];
        if (old && minX >= old.x && minY >= old.y && maxX <= old.x + old.width && maxY <= old.y + old.height) return;
        // Cover the current body and its spring target with room for the next moves.
        // Unlike an unrestricted desktop window, this stays a bounded local surface.
        const slack = 96 * scale, x = Math.max(0, minX - slack), y = Math.max(0, minY - slack);
        leftPaint = [{ x, y, width: Math.min(W, maxX + slack) - x, height: Math.min(H, maxY + slack) - y }];
        if (S.drag?.moved && lastRegionRects.length) void host.setRegions(lastRegionRects, true, leftPaint).catch(() => {});
        lastRegions = '';
    }
    function areaAt(x, y) { const distance = a => Math.hypot(Math.max(a.x - x, 0, x - a.x - a.width), Math.max(a.y - y, 0, y - a.y - a.height)); return [...areas].sort((a, b) => distance(a) - distance(b))[0]; }
    function free(x, y) { const area = S.drag ? areaAt(x, y) : activeArea(); if (S.drag)
        S.display = area.id; const a = Math.min(54 * scale, area.width / 2), b = Math.min(61 * scale, area.height / 2); return { x: clamp(x, area.x + a, area.x + area.width - a), y: clamp(y, area.y + b, area.y + area.height - b) }; }
    function dock(side, x = S.tx, y = S.ty) { const a = activeArea(), height = 49 * scale * dockShape.height / 2, margin = 49 * scale * dockShape.spread + 3; return { x: side === 'left' ? a.x + height : side === 'right' ? a.x + a.width - height : clamp(x, a.x + margin, a.x + a.width - margin), y: side === 'top' ? a.y + height : side === 'bottom' ? a.y + a.height - height : clamp(y, a.y + margin, a.y + a.height - margin) }; }
    // Shares the existing contour, spring state and animation loop.
    // Right click hops. Right drag stretches around the existing anchor and springs back.
    const rightTuning = { distance: 126, height: 46, softness: .24 };
    let rightPlay = null, rightPose = { sx: 1, sy: 1, squeeze: 0 };
    const rightEyesNodes = [-1, 1].map(() => {
        const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        node.setAttribute('fill', 'none'); node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round'); node.setAttribute('opacity', '0');
        $('cb-eyes').append(node); return node;
    });
    function releaseRightCapture(p, keepPaint = true) {
        if (!p) return;
        if (p.pointerId !== undefined && !p.captureReleased) {
            p.captureReleased = true;
            if (pet.hasPointerCapture(p.pointerId)) pet.releasePointerCapture(p.pointerId);
        }
        // Release the native drag region now, even when animation frames are paused.
        if ((p.nativeCaptured && !p.nativeReleased) || (!keepPaint && p.paintRegions?.length)) {
            p.nativeReleased = true;
            if (lastRegionRects.length) void host.setRegions(lastRegionRects, false, keepPaint ? p.paintRegions || [] : []).catch(() => {});
            if (!keepPaint) p.paintRegions = [];
            lastRegions = '';
        }
    }
    function rightCancel(keepHopTarget = false) {
        const p = rightPlay; rightPlay = null; rightPose = { sx: 1, sy: 1, squeeze: 0 };
        if (!p) return;
        if (p.kind === 'hop') {
            S.demo = null;
            if (!keepHopTarget) { S.tx = S.x; S.ty = S.y; S.vx = S.vy = 0; persist(); }
        }
        releaseRightCapture(p, false);
    }
    function rightStart(e) {
        if (e.button !== 2 || rightPlay || S.drag || S.hidden || S.wantsOpen || S.morph > .02) return;
        e.preventDefault(); e.stopImmediatePropagation(); stop(); clear(); visible(); wake();
        const b = $('cb-body').getBBox();
        rightPlay = { kind: 'stretch', pointerId: e.pointerId, holding: true, moved: false, startX: e.clientX, startY: e.clientY,
            rawX: 0, rawY: 0, px: 0, py: 0, pvx: 0, pvy: 0, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } };
        pet.dataset.pointerFocus = 'true';
        try { pet.setPointerCapture(e.pointerId); }
        catch { rightCancel(); }
    }
    function rightMove(e) {
        const p = rightPlay;
        if (p?.kind !== 'stretch' || !p.holding || p.pointerId !== e.pointerId) return;
        const dx = e.clientX - p.startX, dy = e.clientY - p.startY;
        if (!p.moved && Math.hypot(dx, dy) < 5) return;
        if (!p.moved) {
            p.nativeCaptured = true;
            p.paintRegions = rightPaintRegion(S.x, S.y, S.x, S.y, 160 * scale + 20);
            if (lastRegionRects.length) void host.setRegions(lastRegionRects, true, p.paintRegions).catch(() => {});
        }
        p.moved = true; p.rawX = dx; p.rawY = dy; wake();
    }
    function rightRelease(e) {
        const p = rightPlay;
        if (p?.kind !== 'stretch' || !p.holding || p.pointerId !== e.pointerId) return;
        // Fast gestures may deliver down/up without a pointermove in between.
        if (e.type === 'pointerup') rightMove(e);
        const hop = e.type === 'pointerup' && !p.moved;
        p.holding = false; p.rawX = p.rawY = 0;
        releaseRightCapture(p);
        if (hop) { rightCancel(); startRightHop(); }
        // The next native region is the current drawn outline, not the full desktop.
        queueMicrotask(() => { if (!S.drag) draw(performance.now(), 0); });
    }
    pet.addEventListener('pointerdown', rightStart, true);
    pet.addEventListener('pointermove', rightMove);
    pet.addEventListener('pointerup', rightRelease);
    pet.addEventListener('pointercancel', rightRelease);
    pet.addEventListener('lostpointercapture', rightRelease);
    window.addEventListener('blur', () => { if (rightPlay?.holding) rightRelease({ type: 'pointercancel', pointerId: rightPlay.pointerId }); });
    function rightTarget() {
        const a = activeArea(), margin = 69 * scale + 4, x0 = S.x, y0 = S.y, candidates = [], angle = Math.random() * Math.PI * 2;
        for (let i = 0; i < 32; i++) {
            const theta = angle + i * Math.PI / 16, dx = Math.cos(theta), dy = Math.sin(theta), x = x0 + dx * rightTuning.distance, y = y0 + dy * rightTuning.distance;
            const tx = clamp(x, a.x + margin, a.x + a.width - margin), ty = clamp(y, a.y + margin, a.y + a.height - margin), dist = Math.hypot(tx - x0, ty - y0);
            if (dist < 35) continue;
            candidates.push({ x: tx, y: ty });
        }
        // Boundaries constrain the landing point; they must not reward travel
        // toward the centre, which made almost every edge hop point inward.
        return candidates[Math.floor(Math.random() * candidates.length)] || { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    }
    function rightPaintRegion(minX, minY, maxX, maxY, padding) {
        const a = activeArea(), x = Math.max(a.x, minX - padding), y = Math.max(a.y, minY - padding);
        return [{ x, y, width: Math.min(a.x + a.width, maxX + padding) - x, height: Math.min(a.y + a.height, maxY + padding) - y }];
    }
    function startRightHop() {
        if (reduce || rightPlay || S.hidden || S.drag || S.wantsOpen || S.morph > .02) return;
        stop(); clear(); visible(); wake();
        const p = rightTarget();
        rightPlay = { kind: 'hop', start: performance.now(), x0: S.x, y0: S.y, x1: p.x, y1: p.y,
            cy: Math.max(activeArea().y + 68 * scale + 4, (S.y + p.y) / 2 - 2 * rightTuning.height), launched: false, landed: false };
        rightPlay.paintRegions = rightPaintRegion(Math.min(S.x, p.x), Math.min(S.y, p.y, rightPlay.cy), Math.max(S.x, p.x), Math.max(S.y, p.y), 80 * scale + 20);
    }
    function stretchTarget(p, dx, dy) {
        const maxPull = 49 * scale * 1.75, d = Math.hypot(dx, dy), gain = d ? maxPull * Math.tanh(d / maxPull) / d : 0;
        const tx = dx * gain, ty = dy * gain, a = activeArea(), b = p.bounds;
        const roomX = tx > 0 ? a.x + a.width - b.x - b.width : b.x - a.x, roomY = ty > 0 ? a.y + a.height - b.y - b.height : b.y - a.y;
        const fit = Math.min(1, Math.abs(tx) > 1e-5 ? Math.max(0, roomX - 2) / Math.abs(tx) : 1, Math.abs(ty) > 1e-5 ? Math.max(0, roomY - 2) / Math.abs(ty) : 1);
        return { x: tx * fit, y: ty * fit };
    }
    function rightBefore(now, dt) {
        rightPose = { sx: 1, sy: 1, squeeze: 0 };
        if (!rightPlay) return;
        const p = rightPlay;
        if (S.hidden || S.drag || S.wantsOpen || (p.kind === 'hop' && reduce)) { rightCancel(); return; }
        if (p.kind === 'stretch') {
            if (p.holding) wake();
            const target = stretchTarget(p, p.rawX, p.rawY);
            if (reduce) { p.px = target.x; p.py = target.y; p.pvx = p.pvy = 0; }
            else {
                const count = Math.ceil(dt / .008), h = count ? dt / count : 0;
                for (let i = 0; i < count; i++) {
                    p.pvx += ((target.x - p.px) * 190 - p.pvx * 17) * h; p.pvy += ((target.y - p.py) * 190 - p.pvy * 17) * h;
                    p.px += p.pvx * h; p.py += p.pvy * h;
                }
            }
            if (!p.holding && Math.hypot(p.px, p.py) < .15 && Math.hypot(p.pvx, p.pvy) < 1) { rightCancel(); wake(); }
            return;
        }
        const age = (now - p.start) / 1000, soft = rightTuning.softness, prep = .16, flight = .5;
        if (age < prep) { const q = smooth(age / prep); rightPose = { sx: 1 + soft * .28 * q, sy: 1 - soft * .28 * q, squeeze: q * .4 }; return; }
        if (!p.launched) { p.launched = true; release(S.x, S.y); S.demo = { rightClick: true }; }
        const t = clamp((age - prep) / flight, 0, 1), u = smooth(t), one = 1 - u;
        S.tx = lerp(p.x0, p.x1, u); S.ty = one * one * p.y0 + 2 * one * u * p.cy + u * u * p.y1;
        const air = Math.sin(Math.PI * t), releaseWeight = 1 - smooth(t / .25);
        rightPose = { sx: 1 + soft * .28 * releaseWeight - soft * .16 * air, sy: 1 - soft * .28 * releaseWeight + soft * .25 * air, squeeze: releaseWeight * .4 };
        if (t >= 1 && !p.landed) { p.landed = true; kick(5); }
        if (p.landed && ((Math.hypot(S.x - S.tx, S.y - S.ty) < .8 && Math.hypot(S.vx, S.vy) < 5) || age > 2.2)) {
            rightCancel(true); S.mode = 'idle'; wake(); S.face.settlePending = true; persist();
        }
    }
    function rightDeform(x, y) {
        if (rightPlay?.kind !== 'stretch') return [x, y];
        const p = rightPlay, d = Math.hypot(p.px, p.py);
        if (d < 1e-4) return [x, y];
        const nx = p.px / d, ny = p.py / d, radius = 49 * scale, along = (x * nx + y * ny) / radius,
            weight = smooth((along + .15) / 1.15), across = -x * ny + y * nx, pinch = Math.min(.15, d / (radius * 12)) * weight;
        let anchor = 1;
        if (S.side) {
            const a = activeArea(), distance = S.side === 'left' ? S.x + x - a.x : S.side === 'right' ? a.x + a.width - S.x - x : S.side === 'top' ? S.y + y - a.y : a.y + a.height - S.y - y;
            anchor = smooth(Math.max(0, distance) / (radius * .8));
        }
        const dx = (p.px * weight + across * ny * pinch) * anchor, dy = (p.py * weight - across * nx * pinch) * anchor;
        return [x + dx, y + dy];
    }
    function fitRightStretch(base, closedPoints, points, morph) {
        if (!base) return;
        const a = activeArea(); let fit = 1;
        for (let i = 0; i < base.length; i++) for (let axis = 0; axis < 2; axis++) {
            const delta = closedPoints[i][axis] - base[i][axis], low = axis ? a.y : a.x, high = axis ? a.y + a.height : a.x + a.width;
            if (delta > 1e-8) fit = Math.min(fit, Math.max(0, high - base[i][axis]) / delta);
            else if (delta < -1e-8) fit = Math.min(fit, Math.max(0, base[i][axis] - low) / -delta);
        }
        // Limit the entire deformation together; never slice individual contour points.
        if (fit < 1) for (let i = 0; i < base.length; i++) for (let axis = 0; axis < 2; axis++) {
            const delta = closedPoints[i][axis] - base[i][axis];
            closedPoints[i][axis] = base[i][axis] + delta * fit;
            points[i][axis] += delta * (fit - 1) * (1 - morph);
        }
    }
    function rightConstrain(closedPoints, points) {
        if (rightPlay?.kind !== 'hop' || S.wantsOpen) return;
        const a = activeArea(), xs = closedPoints.map(p => p[0]), ys = closedPoints.map(p => p[1]), loX = Math.min(...xs), hiX = Math.max(...xs), loY = Math.min(...ys), hiY = Math.max(...ys);
        const dx = loX < a.x + 2 ? a.x + 2 - loX : hiX > a.x + a.width - 2 ? a.x + a.width - 2 - hiX : 0,
            dy = loY < a.y + 2 ? a.y + 2 - loY : hiY > a.y + a.height - 2 ? a.y + a.height - 2 - hiY : 0;
        if (dx || dy) {
            for (const p of [...closedPoints, ...points]) { p[0] += dx; p[1] += dy; }
            S.x += dx; S.y += dy; if (dx * S.vx < 0) S.vx = 0; if (dy * S.vy < 0) S.vy = 0;
        }
    }
    function rightEyes(eye, sign, index, eyeX, eyeY, gap, ew, eh, tilt, ink) {
        const q = rightPose.squeeze, node = rightEyesNodes[index];
        eye.setAttribute('opacity', q > .0001 ? '0' : '1'); node.setAttribute('opacity', q > .0001 ? '1' : '0');
        if (q <= .0001) return;
        const cx = eyeX + gap * sign, stroke = lerp(ew, 4.2 * scale, q), half = lerp(Math.max(0, (eh - ew) / 2), 5.2 * scale, q),
            outer = cx + sign * 3.1 * scale * q, inner = cx - sign * 3.1 * scale * q;
        node.setAttribute('stroke', ink); node.setAttribute('stroke-width', stroke); node.setAttribute('d', `M${outer},${eyeY - half}L${inner},${eyeY}L${outer},${eyeY + half}`);
        node.setAttribute('transform', `rotate(${tilt} ${cx} ${eyeY})`);
    }

    function kick(strength = 5) { S.impulse = Math.max(S.impulse, strength * config.life); S.phase = 0; }
    function clear() { S.candidate = null; }
    function stop() { rightCancel(); clearLeftPaint(); S.demo = null; S.pull = 0; }
    function cancel() { rightCancel(); clearLeftPaint(); if (!S.drag)
        return; const id = S.drag.id; S.drag = null; if (pet.hasPointerCapture(id))
        pet.releasePointerCapture(id); }
    function wake() { const now = performance.now(); if (S.face.rest > .5)
        S.face.blinkAt = now + 3600; S.face.lastActive = now; S.face.settlePending = false; S.face.settleAt = -Infinity; S.face.curiousArmed = false; S.face.peekStarted = -Infinity; }
    function visible() { S.hidden = false; wake(); }
    function snap(side) {
        const continuing = S.side === side;
        clear();
        S.side = side;
        S.shapeSide = side;
        S.blocked = null;
        S.mode = 'snapping';
        const p = dock(side);
        S.tx = p.x;
        S.ty = p.y;
        S.vx = S.vy = 0;
        S.seen = true;
        if (continuing) {
            S.flow ??= { side, ready: true, age: 2, reach: 1, spread: 1, sink: 1 };
            S.flow.positionMode = 'spring';
        }
        else {
            S.flow = { side, ready: true, age: 0, reach: 0, spread: 0, sink: 0, positionMode: 'flow' };
            S.contact = S.blend = S.press = 0;
            S.impulse = 0;
        }
        persist();
    }
    function nearest(x, y) {
        if (!config.enabled || S.side || S.hidden)
            return null;
        const a = activeArea(), r = 50 * scale, d = { left: x - r - a.x, right: a.x + a.width - x - r, top: y - r - a.y, bottom: a.y + a.height - y - r };
        if (S.blocked && d[S.blocked] > config.distance + 12)
            S.blocked = null;
        const available = edges.filter(side => side !== S.blocked);
        let side = available.reduce((a, b) => d[a] < d[b] ? a : b);
        if (S.candidate && S.candidate !== S.blocked && d[S.candidate] < d[side] + 8)
            side = S.candidate;
        return d[side] <= config.distance ? side : null;
    }
    function release(x, y) { if (S.side) {
        S.blocked = S.side;
        S.flow ??= { side: S.side, ready: true, age: 2, reach: 1, spread: 1, sink: 1, positionMode: 'spring' };
    } S.side = null; clear(); const p = free(x, y); S.tx = p.x; S.ty = p.y; S.mode = 'dragging'; }
    function composerBox() { const a = activeArea(), extra = ($('status').hidden ? 0 : $('status').offsetHeight + 8) + ($('retry').hidden ? 0 : $('retry').offsetHeight + 4), width = Math.min(config.width, Math.max(120, a.width - 32)), height = Math.min(composerHeight, a.height - 32); let x = S.side === 'left' ? a.x + 16 : S.side === 'right' ? a.x + a.width - width - 16 : S.x - width + 30 * scale; x = clamp(x, a.x + 16, Math.max(a.x + 16, a.x + a.width - width - 16)); return { x, y: clamp(S.y - height / 2, a.y + Math.min(96 + extra, a.height - height - 16), Math.max(a.y + 16, a.y + a.height - height - 16)), width, height }; }
    function close(returnFocus = false, notifyHost = true) { if (!S.wantsOpen)
        return; wake(); S.wantsOpen = false; S.focusPending = false; S.returnFocus = returnFocus; if (S.origin) {
        S.tx = S.origin.x;
        S.ty = S.origin.y;
        S.side = S.origin.side;
        S.shapeSide = S.origin.shapeSide;
    } S.mode = S.side ? 'docked' : 'idle'; kick(4); if (notifyHost) { persist(); void host.setMode('collapsed'); } }
    function open(notifyHost = true) { if (S.wantsOpen) return; cancel(); stop(); clear(); visible(); S.seen = true; S.returnFocus = false; if (!S.wantsOpen && (S.morph < .02 || !S.origin))
        S.origin = { x: S.x, y: S.y, side: S.side, shapeSide: S.shapeSide }; if (S.origin) {
        S.x = S.tx = S.origin.x;
        S.y = S.ty = S.origin.y;
        S.vx = S.vy = 0;
    } if (S.flow)
        S.flow.positionMode = 'held'; S.mode = S.side ? 'docked' : 'idle'; S.wantsOpen = true; S.focusPending = true; if (notifyHost) { persist(); void host.setMode('expanded'); } }
    document.addEventListener('pointerdown', e => { if (!S.wantsOpen)
        return; const path = e.composedPath(); if (path.includes(form) || path.includes(chat) || path.includes(pet))
        return; close(false); }, true);
    pet.addEventListener('pointerdown', e => {
        pet.dataset.pointerFocus = 'true';
        if (e.button !== 0 || S.drag || rightPlay?.holding || S.wantsOpen || S.morph > .12)
            return;
        e.preventDefault();
        stop();
        clear();
        visible();
        const r = screen.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (S.side && S.mode === 'snapping') {
            S.tx = S.x;
            S.ty = S.y;
            S.vx = S.vy = 0;
        }
        S.drag = { id: e.pointerId, ox: x - S.x, oy: y - S.y, sx: x, sy: y, moved: false, docked: !!S.side, dx: S.tx, dy: S.ty, p0x: x, p0y: y };
        pet.setPointerCapture(e.pointerId);
        pet.focus({ preventScroll: true });
        kick(2);
    });
    function move(e) {
        const d = S.drag;
        if (!d || e.pointerId !== d.id)
            return;
        wake();
        const r = screen.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (!d.moved && Math.hypot(x - d.sx, y - d.sy) < 5)
            return;
        if (!d.moved) S.face.dragAt = performance.now();
        d.moved = true;
        S.seen = true;
        if (S.side && d.docked) {
            const dx = x - d.p0x, dy = y - d.p0y, side = S.side, inward = Math.max(0, side === 'left' ? dx : side === 'right' ? -dx : side === 'top' ? dy : -dy), limit = profiles[config.motion].pull * scale;
            const p = free(d.dx + dx, d.dy + dy);
            S.tx = (side === 'left' || side === 'right' ? d.dx : p.x) + (side === 'left' ? inward * .43 : side === 'right' ? -inward * .43 : 0);
            S.ty = (side === 'top' || side === 'bottom' ? d.dy : p.y) + (side === 'top' ? inward * .43 : side === 'bottom' ? -inward * .43 : 0);
            S.pull = clamp(inward / limit, 0, 1);
            S.mode = 'detaching';
            if (inward > limit) {
                const next = free(d.dx + dx, d.dy + dy);
                release(next.x, next.y);
                d.docked = false;
                d.ox = x - next.x;
                d.oy = y - next.y;
                S.pull = 0;
                kick(7);
            }
            reserveLeftPaint();
            return;
        }
        const p = free(x - d.ox, y - d.oy);
        S.tx = p.x;
        S.ty = p.y;
        S.mode = 'dragging';
        S.candidate = nearest(p.x, p.y);
        reserveLeftPaint();
    }
    pet.addEventListener('pointermove', move);
    function end(e, cancelled) {
        const d = S.drag;
        if (!d || d.id !== e.pointerId)
            return;
        // A fast gesture can deliver down/up with no intervening move event.
        // Check the release coordinates before deciding whether this was a click.
        if (!cancelled)
            move(e);
        wake();
        S.drag = null;
        S.pull = 0;
        if (pet.hasPointerCapture(d.id))
            pet.releasePointerCapture(d.id);
        // End native dragging immediately, even if animation frames are paused.
        // Keep the existing local paint envelope through the spring return.
        // Releasing capture should not itself resize the native window region.
        if (lastRegionRects.length) {
            void host.setRegions(lastRegionRects, false, leftPaint || []);
            lastRegions = '';
            // Also submit the current drawn contour without waiting for rAF;
            // a diagonal swept path must not linger as a desktop-sized region.
            queueMicrotask(() => { if (!S.drag) draw(performance.now(), 0); });
        }
        if (cancelled) {
            clear();
            if (S.side) {
                const p = dock(S.side);
                S.tx = p.x;
                S.ty = p.y;
            }
            S.mode = S.side ? 'snapping' : 'idle';
            return;
        }
        if (!d.moved) {
            open();
            return;
        }
        S.face.settlePending = true;
        if (S.side)
            snap(S.side);
        else {
            const side = nearest(S.tx, S.ty);
            if (side)
                snap(side);
            else {
                S.mode = 'idle';
                clear();
                kick(5);
                persist();
            }
        }
    }
    pet.addEventListener('pointerup', e => end(e, false));
    pet.addEventListener('pointercancel', e => end(e, true));
    pet.addEventListener('lostpointercapture', e => { if (S.drag?.id === e.pointerId)
        end(e, true); });
    pet.addEventListener('click', e => { if (e.detail === 0)
        open(); });
    pet.addEventListener('pointerenter', () => { wake(); S.hover = true; kick(2); });
    pet.addEventListener('pointerleave', () => S.hover = false);
    screen.addEventListener('pointerdown', e => { const r = screen.getBoundingClientRect(); if (nearPet(e.clientX - r.left, e.clientY - r.top)) wake(); });
    function observePointer(x, y) {
        const seen = S.pointerSeen, moved = seen && Math.hypot(x - S.lookX, y - S.lookY) > 1;
        S.pointerSeen = true; S.lookX = x; S.lookY = y;
        if (nearPet(x, y) && (moved || !seen)) { wake(); if (moved && !S.drag) S.face.curiousArmed = true; }
    }
    screen.addEventListener('pointermove', e => { const r = screen.getBoundingClientRect(); observePointer(e.clientX - r.left, e.clientY - r.top); });
    screen.addEventListener('pointerleave', () => { S.lookX = S.x; S.lookY = S.y; });
    pet.addEventListener('keydown', e => {
        delete pet.dataset.pointerFocus;
        const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' };
        if (!map[e.key])
            return;
        e.preventDefault();
        cancel();
        stop();
        clear();
        visible();
        S.seen = true;
        if (e.shiftKey) {
            if (config.enabled)
                snap(map[e.key]);
            return;
        }
        const step = e.altKey ? 4 : 20;
        release(S.tx + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0), S.ty + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0));
        S.mode = 'idle';
        kick(3);
        persist();
    });
    pet.addEventListener('contextmenu', e => { e.preventDefault(); });
    document.addEventListener('keydown', e => { if (e.key === 'Tab')
        delete pet.dataset.pointerFocus; });
    function resize(next = stage) {
        stage = next;
        areas = next.areas.map(a => ({ ...a, x: a.x - next.bounds.x, y: a.y - next.bounds.y }));
        W = next.bounds.width;
        H = next.bounds.height;
        cancel();
        stop();
        clear();
        S.side = next.position.side;
        S.shapeSide = S.side || S.shapeSide;
        S.display = next.position.displayId || areaAt(next.position.x - next.bounds.x, next.position.y - next.bounds.y).id;
        const p = S.side ? dock(S.side, next.position.x - next.bounds.x, next.position.y - next.bounds.y) : free(next.position.x - next.bounds.x, next.position.y - next.bounds.y);
        S.x = S.tx = p.x;
        S.y = S.ty = p.y;
        S.vx = S.vy = 0;
        S.flow = null;
        S.contact = S.blend = S.side ? 1 : 0;
        S.press = 0;
        S.mode = S.side ? 'docked' : 'idle';
        if (S.origin)
            S.origin = { x: p.x, y: p.y, side: S.side, shapeSide: S.shapeSide };
        S.lookX = S.x;
        S.lookY = S.y;
        lastRegions = '';
        $('cb-scene').setAttribute('viewBox', `0 0 ${W} ${H}`);
    }
    function renderSettings(save = false) { cancel(); stop(); clear(); const oldScale = scale, detached = !!(!config.enabled && S.side); scale = config.size / 100; if (!/^#[0-9a-f]{6}$/i.test(config.color))
        config.color = '#19191c'; root.style.setProperty('--cb-pet-color', config.color); if (detached)
        release(S.x, S.y); const p = S.side ? (scale !== oldScale ? dock(S.side) : { x: S.tx, y: S.ty }) : free(S.tx, S.ty); S.tx = p.x; S.ty = p.y; if (S.origin && S.wantsOpen && (scale !== oldScale || detached))
        Object.assign(S.origin, { x: p.x, y: p.y, side: S.side, shapeSide: S.shapeSide }); S.mode = S.side ? 'snapping' : 'idle'; if (save)
        persist(); }
    scale = config.size / 100;
    resize();
    renderSettings();
    window.pet = {
        configure(settings) { messageHeight = Number.isInteger(settings.messageHeight) ? clamp(settings.messageHeight, 120, 800) : 380; let changed = false; for (const [key, field] of Object.entries(optionKeys)) {
            if (settings[field] !== undefined && settings[field] !== config[key]) {
                config[key] = settings[field];
                changed = true;
            }
        } if (changed)
            renderSettings(); },
        setMode(mode) { document.body.dataset.mode = mode; if (mode === 'hidden') {
            S.hidden = true;
            S.wantsOpen = false;
            S.focusPending = false;
            cancel();
            return;
        } S.hidden = false; if (mode === 'expanded') {
            if (!S.wantsOpen)
                open(false);
        }
        else if (S.wantsOpen)
            close(false, false); },
        resizeComposer(height) { composerHeight = clamp(height, 42, 100); },
        inspect() { return { x: S.x, y: S.y, tx: S.tx, ty: S.ty, side: S.side, candidate: S.candidate, dragging: !!S.drag, mode: S.mode, morph: S.morph, expression: S.face.kind, faceAction: S.face.action }; }
    };
    host.onDesktopScene(next => { resize(next); window.pet.setMode(next.mode); });
    host.onPointer(point => observePointer(point.x, point.y));
    window.pet.setMode(stage.mode);
    window.dispatchEvent(new Event('pet-ready'));
    function reportRegions(points, opened, showChat) {
        const xs = points.map(p => p[0]), ys = points.map(p => p[1]), x = Math.min(...xs) - 10, y = Math.min(...ys) - 10;
        const regions = [{ x, y, width: Math.max(...xs) - x + 10, height: Math.max(...ys) - y + 12 }];
        for (const node of [opened ? form : null, showChat ? chat : null, opened && !$('capture-menu').hidden ? $('capture-menu') : null])
            if (node) {
                const r = node.getBoundingClientRect();
                if (r.width > 0 && r.height > 0)
                    regions.push({ x: r.x - 2, y: r.y - 2, width: r.width + 4, height: r.height + 4 });
            }
        const dragging = !!S.drag?.moved || !!(rightPlay?.holding && rightPlay.moved), paint = rightPlay?.paintRegions || leftPaint || [];
        const rounded = regions.map(r => ({ x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) })), key = JSON.stringify([rounded, dragging, paint]);
        lastRegionRects = rounded;
        if (key !== lastRegions) {
            lastRegions = key;
            void host.setRegions(rounded, dragging, paint).catch(() => { lastRegions = ''; });
        }
    }
    const contourCount = 48;
    function normal(side) { return side === 'left' ? [-1, 0] : side === 'right' ? [1, 0] : side === 'top' ? [0, -1] : [0, 1]; }
    function capsuleContour(halfWidth, radius) {
        const segments = [], straight = halfWidth - radius;
        const arc = (center, start) => { const step = Math.PI / 20, k = 4 / 3 * Math.tan(step / 4); for (let i = 0; i < 10; i++) {
            const a = start + i * step, b = a + step, p = [center + radius * Math.cos(a), radius * Math.sin(a)], q = [center + radius * Math.cos(b), radius * Math.sin(b)];
            segments.push({ p, c1: [p[0] - k * radius * Math.sin(a), p[1] + k * radius * Math.cos(a)], c2: [q[0] + k * radius * Math.sin(b), q[1] - k * radius * Math.cos(b)] });
        } };
        const line = (from, to, y) => { const step = (to - from) / 4; for (let i = 0; i < 4; i++) {
            const x = from + i * step;
            segments.push({ p: [x, y], c1: [x + step / 3, y], c2: [x + step * 2 / 3, y] });
        } };
        // Same 48 segments as the pet; explicit straight handles prevent spline overshoot.
        arc(straight, 0);
        line(straight, -straight, radius);
        arc(-straight, Math.PI / 2);
        arc(-straight, Math.PI);
        line(-straight, straight, -radius);
        arc(straight, Math.PI * 1.5);
        return segments;
    }
    function eyeFit(points, x, y, dx, dy, halfWidth, halfHeight) {
        const fits = t => { for (const sx of [-1, 1])
            for (const sy of [-1, 1]) {
                const px = x + dx * t + sx * halfWidth, py = y + dy * t + sy * halfHeight;
                for (let i = 0; i < points.length; i++) {
                    const a = points[i], b = points[(i + 1) % points.length], ex = b[0] - a[0], ey = b[1] - a[1];
                    if (ex * (py - a[1]) - ey * (px - a[0]) < .5 * Math.hypot(ex, ey))
                        return false;
                }
            } return true; };
        if (fits(1))
            return 1;
        let low = 0, high = 1;
        for (let i = 0; i < 10; i++) {
            const mid = (low + high) / 2;
            if (fits(mid))
                low = mid;
            else
                high = mid;
        }
        return low;
    }
    function path(points, capsule, m, cx, cy) {
        const supported = p => S.side ? [clamp(p[0], 0, W), clamp(p[1], 0, H)] : p;
        const blend = (p, q) => [lerp(p[0], cx + q[0], m), lerp(p[1], cy + q[1], m)];
        let d = 'M' + blend(points[0], capsule[0].p).map(x => x.toFixed(2)).join(',');
        const n = points.length;
        for (let i = 0; i < n; i++) {
            const a = points[(i + n - 1) % n], b = points[i], c = points[(i + 1) % n], f = points[(i + 2) % n];
            const tangent = (p, q, r) => { const x = r[0] - p[0], y = r[1] - p[1], length = Math.hypot(x, y) || 1, l = Math.min(Math.hypot(q[0] - p[0], q[1] - p[1]), Math.hypot(r[0] - q[0], r[1] - q[1])) * .34; return [x / length * l, y / length * l]; };
            const t1 = tangent(a, b, c), t2 = tangent(b, c, f);
            d += 'C' + [...blend(supported([b[0] + t1[0], b[1] + t1[1]]), capsule[i].c1), ...blend(supported([c[0] - t2[0], c[1] - t2[1]]), capsule[i].c2), ...blend(c, capsule[(i + 1) % n].p)].map(x => x.toFixed(2)).join(',');
        }
        return d + 'Z';
    }
    const mixColor = (a, b, t) => 'rgb(' + a.map((c, i) => Math.round(lerp(c, b[i], t))).join(',') + ')';
    function expression(now, dt, preload) {
        const face = S.face, preview = expressionPreview.expression, idle = now - face.lastActive, busy = S.wantsOpen || S.morph > .1;
        const kind = busy ? 'idle' : preview !== 'auto' ? preview : S.drag || S.demo ? 'drag' : S.side && S.mode === 'snapping' && preload > .01 ? 'land' : idle > 10000 ? 'rest' : 'idle';
        const animate = !reduce && !busy && !S.hidden && preview === 'auto';
        // Occasionally peek left, then right, then return to the existing sleepy
        // pose. All timing uses the current animation clock, with no new timers.
        if (!animate) { face.curiousArmed = false; face.peekStarted = -Infinity; }
        if (idle > 35000) face.curiousArmed = false;
        if (animate && kind === 'rest' && face.curiousArmed && idle >= 22000 && idle <= 35000 && now - face.lastPeekAt >= 90000 && !Number.isFinite(face.peekStarted)) {
            face.curiousArmed = false; face.peekStarted = face.lastPeekAt = now; face.peekDirection = face.peekCount++ % 2 ? -1 : 1;
        }
        const scanTime = (now - face.peekStarted) / 3800;
        const curious = animate && kind === 'rest' && scanTime >= 0 && scanTime < 1
            ? .75 * smooth(scanTime / .16) * (1 - smooth((scanTime - .80) / .20)) : 0;
        const scanX = face.peekDirection * (-6 * smooth(scanTime / .22) + 12 * smooth((scanTime - .34) / .24) - 6 * smooth((scanTime - .72) / .22));
        if (scanTime >= 1) face.peekStarted = -Infinity;
        const restGoal = kind === 'rest' ? (preview === 'rest' ? 1 : smooth((idle - 10000) / 2000)) * (1 - .9 * curious) : 0, landGoal = kind === 'land' ? (preview === 'land' ? 1 : clamp(preload * 3, 0, 1)) : 0;
        for (const [key, goal, rate] of [['drag', kind === 'drag' ? 1 : 0, 12], ['land', landGoal, 10], ['rest', restGoal, 7]])
            face[key] = lerp(face[key], goal, reduce ? 1 : 1 - Math.exp(-dt * rate));
        face.kind = kind;
        pet.dataset.expression = kind;
        if (now > face.blinkAt + 190) {
            face.blinkAt = now + 4500 + (face.blinkCount++ % 3) * 700;
        }
        if (!animate) { face.settlePending = false; face.settleAt = -Infinity; }
        if (animate && face.settlePending && !S.drag && Math.hypot(S.tx - S.x, S.ty - S.y) < 1.5 && Math.hypot(S.vx, S.vy) < 14 && (S.mode !== 'snapping' || S.blend > .96)) {
            face.settlePending = false; face.settleAt = now; face.blinkAt = now + 4200;
        }
        const pulse = (age, start, duration) => age >= start && age <= start + duration ? Math.sin(Math.PI * (age - start) / duration) ** 2 : 0;
        const settleAge = now - face.settleAt, settleBlink = animate && !S.drag ? Math.max(pulse(settleAge, 70, 150), .8 * pulse(settleAge, 320, 150)) : 0;
        const phase = (now - face.blinkAt) / 190, blink = Math.min(1 - .80 * settleBlink, !reduce && kind === 'idle' && !busy && phase >= 0 && phase <= 1 ? 1 - .92 * Math.sin(Math.PI * phase) ** 2 : 1);
        const dragAge = Math.max(0, (now - face.dragAt) / 1000), recoil = animate && S.drag && S.drag.moved ? Math.sin(dragAge * 21) * Math.exp(-dragAge * 7) : 0;
        const squeeze = animate && S.drag && S.drag.moved ? pulse(dragAge, 0, .20) : 0;
        const tilt = animate ? (!S.drag || S.drag.moved ? clamp(-S.vx / 150, -4, 4) * face.drag : 0) + recoil * 3 + curious * scanX * .2 : 0;
        face.action = animate && S.drag && S.drag.moved ? 'drag-recoil' : curious > .01 ? 'curious' : settleBlink > .01 ? 'settle-blink' : '';
        pet.dataset.faceAction = face.action;
        const size = clamp(Number.isFinite(config.eyeSize) ? config.eyeSize : 100, 70, 140) / 100;
        return { width: lerp(6.7 * eyeScale * (1 + .22 * face.drag + .1 * face.land), 11.5 * eyeScale, face.rest) * size * (1 + .04 * squeeze), height: lerp(17 * eyeScale * (1 + .08 * face.drag) * (1 - .65 * face.land), 2.1, face.rest) * size * (1 - .18 * squeeze), blink,
            tilt, asymmetry: -curious * clamp(scanX / 6, -1, 1) * .10, scanX, curious, dragX: animate && S.drag?.moved ? -clamp(S.vx / 300, -1.5, 1.5) : 0, dragY: animate && S.drag?.moved ? -clamp(S.vy / 350, -1, 1) : 0 };
    }
    function draw(now, dt) {
        const m = clamp(S.morph, 0, 1), ui = m, box = composerBox(), hw = box.width / 2, r = box.height / 2, cx = box.x + hw, cy = box.y + r, capsule = capsuleContour(hw, r);
        const edgeHold = !!(S.drag && !S.side && S.candidate), f = S.flow, tail = S.side ? 1 : f?.reach ? clamp(S.contact / f.reach, 0, 1) : 0;
        const reach = edgeHold ? 0 : S.side ? (f ? f.reach : 1) : (f?.reach || 0) * tail;
        const load = edgeHold ? 0 : S.side ? (f ? f.sink : 1) : (f?.sink || 0) * tail;
        const recoil = !reduce && S.side && !S.drag && f ? Math.sin(f.age * 7) * Math.exp(-Math.max(0, f.age - .8) * 2) * .012 * load : 0;
        const area = activeArea(), contactSide = S.side || f?.side || S.shapeSide, [nx, ny] = normal(contactSide), axisSign = nx || ny, edgePlane = contactSide === 'right' ? area.x + area.width : contactSide === 'bottom' ? area.y + area.height : contactSide === 'left' ? area.x : area.y, wallDepth = (edgePlane - (nx ? S.x : S.y)) * axisSign;
        const speed = Math.hypot(S.vx, S.vy), ux = speed ? S.vx / speed : 1, uy = speed ? S.vy / speed : 0, stretch = !reduce && (S.drag || rightPlay?.kind === 'hop') && !edgeHold && !S.side ? clamp(speed / 2500, 0, .22) : 0;
        const radius = (49 + (!reduce && !edgeHold && !S.side ? Math.sin(now / 1100) * .35 * config.life : 0)) * scale;
        const proximity = smooth((radius + 2 * scale - wallDepth) / (10 * scale)), slump = clamp(load * proximity - recoil, 0, 1), preload = reach * proximity * (1 - slump), preScale = 1 - .035 * preload, pullScale = 1 + S.pull * .32;
        const frontExtent = lerp(radius * preScale, radius * dockShape.height / 2, slump) * pullScale, penetration = frontExtent - wallDepth, support = reach > 0 ? (penetration + Math.hypot(penetration, .1 * scale)) / 2 : 0;
        const stretchBase = rightPlay?.kind === 'stretch' ? [] : null;
        const closedPoints = [], points = Array.from({ length: contourCount }, (_, i) => {
            const a = i * Math.PI * 2 / contourCount, c = Math.cos(a), s = Math.sin(a), u = c * nx + s * ny, v = -c * ny + s * nx;
            // Deform the whole visible mass into a supported cap; never slice it at the wall.
            let depth = lerp(radius * preScale * u, radius * dockShape.height * (.5 + Math.min(u, 0)), slump) * pullScale - support, tangent = lerp(radius / preScale, radius * dockShape.spread, slump) * v;
            let x = depth * nx - tangent * ny, y = depth * ny + tangent * nx;
            if (!reduce && !edgeHold && !S.side) {
                const wobble = Math.sin(S.phase * 12) * S.impulse * .004;
                x *= 1 + wobble;
                y /= 1 + wobble;
            }
            const along = x * ux + y * uy, across = -x * uy + y * ux;
            x = along * (1 + stretch) * ux - across / (1 + stretch * .6) * uy;
            y = along * (1 + stretch) * uy + across / (1 + stretch * .6) * ux;
            x *= rightPose.sx; y *= rightPose.sy;
            if (stretchBase) stretchBase.push([S.x + x, S.y + y]);
            [x, y] = rightDeform(x, y);
            closedPoints.push([S.x + x, S.y + y]);
            return [lerp(S.x + x, cx + capsule[i].p[0], m), lerp(S.y + y, cy + capsule[i].p[1], m)];
        });
        fitRightStretch(stretchBase, closedPoints, points, m);
        rightConstrain(closedPoints, points);
        const d = path(closedPoints, capsule, m, cx, cy);
        $('cb-body').setAttribute('d', d);
        $('cb-rim').setAttribute('d', d);
        const base = [1, 3, 5].map(i => parseInt(config.color.slice(i, i + 2), 16)), tint = background => background.map((v, i) => lerp(v, base[i], .035));
        const light = tint(dark ? [50, 53, 59] : [249, 249, 250]), mid = tint(dark ? [40, 43, 49] : [244, 244, 246]), deep = tint(dark ? [34, 37, 43] : [233, 234, 237]);
        $('cb-light').setAttribute('stop-color', mixColor(base.map(v => lerp(v, 255, .27)), light, ui));
        $('cb-mid').setAttribute('stop-color', mixColor(base.map(v => lerp(v, 255, .035)), mid, ui));
        $('cb-dark').setAttribute('stop-color', mixColor(base.map(v => v * .7), deep, ui));
        const luminance = base.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0), eyeInk = luminance > .179 ? '#111114' : '#fff';
        $('cb-eyes').setAttribute('fill', eyeInk);
        root.style.setProperty('--cb-send-ink', eyeInk);
        const face = expression(now, dt, preload), lookDX = S.lookX - S.x, lookDY = S.lookY - S.y, lookDistance = Math.hypot(lookDX, lookDY), followWeight = smooth((followRadius() - lookDistance) / (followRadius() * .15)), lookStrength = Math.tanh(lookDistance / 90) * followWeight * (1 - .92 * S.face.rest), glanceWeight = Math.min(1, face.curious / .75), goalX = lerp(lookDistance ? lookDX / lookDistance * config.gaze * lookStrength : 0, face.scanX, glanceWeight) + face.dragX, goalY = lerp(lookDistance ? lookDY / lookDistance * config.gaze * (lookDY < 0 ? 1.15 : .85) * lookStrength : 0, -2, glanceWeight) + face.dragY;
        if (reduce) {
            S.gazeX = goalX;
            S.gazeY = goalY;
            S.gazeVX = S.gazeVY = 0;
        }
        else {
            const count = Math.ceil(dt / .008), h = dt / count;
            for (let i = 0; i < count; i++) {
                S.gazeVX += ((goalX - S.gazeX) * 260 - S.gazeVX * 26) * h;
                S.gazeVY += ((goalY - S.gazeY) * 260 - S.gazeVY * 26) * h;
                S.gazeX += S.gazeVX * h;
                S.gazeY += S.gazeVY * h;
            }
        }
        const gazeRoomX = Math.max(8, ((S.side === 'left' || S.side === 'right' ? 39 : 45) * scale - 13.85 * eyeScale - 1) / scale), gazeRoomY = Math.max(8, (45 * scale - 8.5 * eyeScale - 1) / scale), gazeEnvelope = Math.hypot(S.gazeX / Math.min(S.side === 'left' || S.side === 'right' ? 26 : 30, gazeRoomX), S.gazeY / Math.min(S.gazeY < 0 ? 34 : 27, gazeRoomY));
        if (gazeEnvelope > 1) {
            S.gazeX /= gazeEnvelope;
            S.gazeY /= gazeEnvelope;
        }
        const tiltPadding = Math.abs(Math.sin(face.tilt * Math.PI / 180));
        const faceOffset = support + radius * .06 * slump, faceBaseX = S.x - nx * faceOffset, faceBaseY = S.y - ny * faceOffset - 6 * eyeScale, gazeFit = eyeFit(closedPoints, faceBaseX, faceBaseY, S.gazeX * scale, S.gazeY * scale, 10.5 * eyeScale + face.width / 2 + tiltPadding * face.height * .56 + .5, face.height * .56 + tiltPadding * face.width / 2 + .5);
        const faceX = faceBaseX + S.gazeX * scale * gazeFit, faceY = faceBaseY + S.gazeY * scale * gazeFit, sendX = box.x + box.width - 22, sendY = cy, eyeX = lerp(faceX, sendX, smooth(ui)), eyeY = lerp(faceY, sendY, smooth(ui));
        const collapse = smooth((ui - .38) / .48), gap = lerp(10.5 * eyeScale, 0, collapse), ew = lerp(face.width, 3, collapse), eh = lerp(face.height, 5, collapse);
        for (const [id, sign] of [['cb-eye-left', -1], ['cb-eye-right', 1]]) {
            const eye = $(id), height = eh * lerp(face.blink, 1, ui) * (1 + sign * face.asymmetry * (1 - ui));
            eye.setAttribute('x', (eyeX + gap * sign - ew / 2).toFixed(2));
            eye.setAttribute('y', (eyeY - height / 2).toFixed(2));
            eye.setAttribute('width', ew.toFixed(2));
            eye.setAttribute('height', height.toFixed(2));
            eye.setAttribute('rx', (Math.min(ew, height) / 2).toFixed(2));
            eye.setAttribute('transform', `rotate(${(face.tilt * (1 - ui)).toFixed(2)} ${(eyeX + gap * sign).toFixed(2)} ${eyeY.toFixed(2)})`);
        }
        for (const [index, sign] of [[0, -1], [1, 1]]) rightEyes($(sign < 0 ? 'cb-eye-left' : 'cb-eye-right'), sign, index, eyeX, eyeY, gap, ew, eh, face.tilt * (1-ui), eyeInk);
        $('cb-eyes').setAttribute('opacity', (1 - smooth((ui - .75) / .2)).toFixed(3));
        const sendSkin = $('cb-send-skin');
        sendSkin.setAttribute('cx', sendX);
        sendSkin.setAttribute('cy', sendY);
        sendSkin.setAttribute('r', 14 * (1 - S.sendPulse * .12));
        sendSkin.setAttribute('fill', config.color);
        sendSkin.setAttribute('opacity', smooth((ui - .45) / .4));
        const minX = Math.min(...points.map(p => p[0])), minY = Math.min(...points.map(p => p[1])), maxX = Math.max(...points.map(p => p[0])), maxY = Math.max(...points.map(p => p[1]));
        pet.style.width = (maxX - minX + 16) + 'px';
        pet.style.height = (maxY - minY + 16) + 'px';
        pet.style.margin = '0';
        pet.style.transform = `translate(${minX - 8}px,${minY - 8}px)`;
        pet.hidden = S.hidden || S.wantsOpen || m > .06;
        pet.dataset.mode = S.mode;
        pet.dataset.interaction = rightPlay?.kind || '';
        pet.dataset.rightHeld = String(!!rightPlay?.holding);
        pet.dataset.side = S.side || '';
        const opened = !S.hidden && (S.wantsOpen || ui > .01);
        form.hidden = !opened;
        form.style.left = box.x + 'px';
        form.style.top = box.y + 'px';
        form.style.width = box.width + 'px';
        form.style.height = box.height + 'px';
        form.style.opacity = smooth((ui - .5) / .4);
        form.style.pointerEvents = S.wantsOpen && ui > .9 ? 'auto' : 'none';
        form.inert = !S.wantsOpen || ui < .9;
        $('send').style.opacity = smooth((ui - .78) / .18);
        $('send').disabled = !S.wantsOpen || ui < .9 || $('capture').dataset.state === 'capturing';
        const showChat = opened && ui > .78;
        chat.hidden = !showChat;
        chat.inert = !S.wantsOpen;
        chat.style.opacity = smooth((ui - .78) / .2);
        chat.style.width = box.width + 'px';
        chat.style.left = box.x + 'px';
        chat.style.bottom = (H - box.y + 14) + 'px';
        chat.style.pointerEvents = S.wantsOpen ? 'auto' : 'none';
        $('messages').style.maxHeight = Math.max(26, Math.min(messageHeight, box.y - area.y - 22 - ($('status').hidden ? 0 : $('status').offsetHeight + 8) - ($('retry').hidden ? 0 : $('retry').offsetHeight + 4))) + 'px';
        if (S.focusPending && S.wantsOpen && ui > .97) {
            S.focusPending = false;
            $('input').focus({ preventScroll: true });
        }
        if (S.returnFocus && !S.wantsOpen && ui < .04 && !S.hidden) {
            S.returnFocus = false;
            pet.focus({ preventScroll: true });
        }
        $('cb-scene').style.visibility = S.hidden ? 'hidden' : 'visible';
        reportRegions(points, opened, showChat);
    }
    function tick(now) {
        if (!root.isConnected)
            return;
        const dt = clamp((now - last) / 1000, .001, .032);
        last = now;
        rightBefore(now, dt);
        const profile = profiles[config.motion], goal = S.wantsOpen ? 1 : 0;
        const f = S.flow, canFlow = S.side && !S.drag && !S.demo && !S.wantsOpen && S.morph < .02 && f?.positionMode !== 'held';
        if (f && canFlow) {
            f.age += dt;
            const t = lerp(10, 4.5, config.viscosity) * f.age, decay = Math.exp(-t);
            f.reach = clamp(1 - (1 + t) * decay, 0, 1);
            // A continuous lag gives a short preload without a timer, pause, or stage switch.
            f.spread = f.sink = clamp(1 - (1 + t + t * t / 2 + t * t * t / 6) * decay, 0, 1);
        }
        if (reduce) {
            S.x = S.tx;
            S.y = S.ty;
            S.vx = S.vy = 0;
            S.morph = goal;
            S.morphV = 0;
            S.impulse = 0;
            S.blend = S.contact = S.side ? 1 : 0;
            S.press = 0;
            if (f) {
                f.ready = true;
                f.age = 2;
                f.reach = f.spread = f.sink = 1;
            }
        }
        else {
            const count = Math.ceil(dt / .008), h = dt / count;
            for (let i = 0; i < count; i++) {
                if (S.side && !S.drag && !S.demo) {
                    if (!S.wantsOpen && S.morph < .02) {
                        const omega = lerp(10, 4.5, config.viscosity), decay = Math.exp(-omega * h), jx = S.vx + omega * (S.x - S.tx), jy = S.vy + omega * (S.y - S.ty);
                        S.x = S.tx + (S.x - S.tx + jx * h) * decay;
                        S.y = S.ty + (S.y - S.ty + jy * h) * decay;
                        S.vx = (S.vx - omega * jx * h) * decay;
                        S.vy = (S.vy - omega * jy * h) * decay;
                    }
                }
                else {
                    S.vx += ((S.tx - S.x) * profile.k - S.vx * profile.d) * h;
                    S.vy += ((S.ty - S.y) * profile.k - S.vy * profile.d) * h;
                    S.x += S.vx * h;
                    S.y += S.vy * h;
                }
                S.morphV += ((goal - S.morph) * 145 - S.morphV * 20) * h;
                S.morph += S.morphV * h;
            }
        }
        S.phase += dt;
        S.impulse *= Math.exp(-dt * 5);
        S.sendPulse *= Math.exp(-dt * 9);
        if (!reduce) {
            if (S.side) {
                S.contact = f ? f.reach : 1;
                S.blend = f ? f.sink : 1;
                S.press = f ? f.spread * (1 - f.sink) : 0;
            }
            else {
                S.contact *= Math.exp(-dt * 9);
                S.blend *= Math.exp(-dt * profile.m);
                S.press *= Math.exp(-dt * 8);
            }
        }
        if (S.mode === 'snapping' && Math.hypot(S.x - S.tx, S.y - S.ty) < .7 && Math.hypot(S.vx, S.vy) < 5 && S.blend > .985 && (!f || f.spread > .99))
            S.mode = 'docked';
        if (leftPaint) {
            if (S.drag) reserveLeftPaint();
            else if (!S.wantsOpen && Math.hypot(S.x - S.tx, S.y - S.ty) < .8 && Math.hypot(S.vx, S.vy) < 5 && (S.mode !== 'snapping' || S.blend > .99)) leftPaint = null;
        }
        draw(now, dt);
        requestAnimationFrame(tick);
    }
    draw(performance.now(), .016);
    requestAnimationFrame(tick);
})().catch(() => { console.error('Pet renderer initialization failed'); });
