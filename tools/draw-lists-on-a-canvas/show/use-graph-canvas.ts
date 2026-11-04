import * as React from 'react';
import type { CanvasCamera, CanvasNodeFrame } from './types';

interface UseGraphCanvasOptions {
  nodes: CanvasNodeFrame[];
  canvasRef: React.RefObject<HTMLDivElement | null>;
  initialCamera?: Partial<CanvasCamera>;
  onCameraChange?: (camera: CanvasCamera) => void;
  enableNodeDrag?: boolean;
  /**
   * Trackpad/gesture camera input. Both default ON — turning one off turns
   * off that input only, never the toolbar/minimap camera controls.
   * - `pinchZoom`: trackpad pinch (ctrl/meta-wheel in Chromium, WebKit
   *   gesture events in Safari/WKWebView) zooms around the pointer.
   * - `scrollPan`: two-finger scroll pans the world.
   */
  enablePinchZoom?: boolean;
  enableScrollPan?: boolean;
  /**
   * The smallest zoom a fit may choose. Cards carrying text need more than the
   * default floor; below it the view anchors at the top and the rest scrolls.
   */
  fitMinZoom?: number;
}

type DragEndCallback = (nodeId: string, finalX: number, finalY: number) => void;

type InteractionState =
  | { kind: 'idle' }
  | {
      kind: 'pan';
      startScreenX: number;
      startScreenY: number;
      startPanX: number;
      startPanY: number;
    }
  | {
      kind: 'drag';
      nodeId: string;
      startScreenX: number;
      startScreenY: number;
      startNodeX: number;
      startNodeY: number;
    };

const DEFAULT_CAMERA: CanvasCamera = { pan_x: 0, pan_y: 0, zoom: 1 };
const WHEEL_LINE_PIXEL_SCALE = 16;
const WHEEL_ZOOM_OUT_FACTOR = 0.95;
const WHEEL_ZOOM_IN_FACTOR = 1.055;
const MAX_REMEMBERED_LOCAL_CAMERAS = 16;
const ZOOM_TO_FIT_PADDING = 48;
// Fit never zooms PAST 100%: fitting two nodes should center them at natural
// size, not blow them up to fill the screen (n8n/FigJam fit behavior).
const ZOOM_TO_FIT_MAX = 1;
// Fit never zooms BELOW readability either: a huge graph fits to the floor
// and the user pans/minimaps from there — an unreadable confetti wall is
// worse than a partial view (Lindy/n8n never render sub-readable fits).
const ZOOM_TO_FIT_MIN = 0.3;

function clampZoom(zoom: number): number {
  return Math.max(0.1, Math.min(4, zoom));
}

function hasUsableViewport(rect: DOMRect, padding: number): boolean {
  return Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > padding * 2
    && rect.height > padding * 2;
}

function wheelDeltaPixels(event: WheelEvent, element: HTMLElement): { x: number; y: number } {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return {
      x: event.deltaX * WHEEL_LINE_PIXEL_SCALE,
      y: event.deltaY * WHEEL_LINE_PIXEL_SCALE,
    };
  }

  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    const pagePixels = Math.max(1, element.clientHeight || window.innerHeight || 1);
    return {
      x: event.deltaX * pagePixels,
      y: event.deltaY * pagePixels,
    };
  }

  return {
    x: event.deltaX,
    y: event.deltaY,
  };
}

function normalizedCamera(camera: Partial<CanvasCamera>, fallback: CanvasCamera): CanvasCamera {
  return {
    pan_x: camera.pan_x ?? fallback.pan_x,
    pan_y: camera.pan_y ?? fallback.pan_y,
    zoom: camera.zoom ?? fallback.zoom,
  };
}

function cameraKey(camera: CanvasCamera): string {
  return `${camera.pan_x.toFixed(4)}:${camera.pan_y.toFixed(4)}:${camera.zoom.toFixed(6)}`;
}

function sameCamera(left: CanvasCamera, right: CanvasCamera): boolean {
  return cameraKey(left) === cameraKey(right);
}

function zoomFactorFromWheelDirection(deltaPixelsY: number): number {
  if (deltaPixelsY > 0) return WHEEL_ZOOM_OUT_FACTOR;
  if (deltaPixelsY < 0) return WHEEL_ZOOM_IN_FACTOR;
  return 1;
}

export function useGraphCanvas({
  nodes,
  canvasRef,
  initialCamera,
  onCameraChange,
  enableNodeDrag = true,
  enablePinchZoom = true,
  enableScrollPan = true,
  fitMinZoom = ZOOM_TO_FIT_MIN,
}: UseGraphCanvasOptions) {
  const [camera, setCamera] = React.useState<CanvasCamera>({
    ...DEFAULT_CAMERA,
    ...initialCamera,
  });
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);
  const [draggedNodeId, setDraggedNodeId] = React.useState<string | null>(null);
  const [draggedNodePosition, setDraggedNodePosition] = React.useState<{ x: number; y: number } | null>(null);

  const cameraRef = React.useRef(camera);
  const onCameraChangeRef = React.useRef(onCameraChange);
  const interactionRef = React.useRef<InteractionState>({ kind: 'idle' });
  const dragEndCallbackRef = React.useRef<DragEndCallback | null>(null);
  const localCameraKeysRef = React.useRef<string[]>([]);

  React.useEffect(() => {
    onCameraChangeRef.current = onCameraChange;
  }, [onCameraChange]);

  React.useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  const rememberLocalCamera = React.useCallback((nextCamera: CanvasCamera) => {
    const key = cameraKey(nextCamera);
    const keys = localCameraKeysRef.current.filter((candidate) => candidate !== key);
    keys.push(key);
    localCameraKeysRef.current = keys.slice(-MAX_REMEMBERED_LOCAL_CAMERAS);
  }, []);

  const setLocalCamera = React.useCallback((nextCamera: CanvasCamera) => {
    const normalized = normalizedCamera(nextCamera, cameraRef.current);
    cameraRef.current = normalized;
    rememberLocalCamera(normalized);
    setCamera(normalized);
    onCameraChangeRef.current?.(normalized);
  }, [rememberLocalCamera]);

  React.useEffect(() => {
    if (!initialCamera) return;
    const nextCamera = normalizedCamera(initialCamera, cameraRef.current);
    if (sameCamera(nextCamera, cameraRef.current)) return;
    if (localCameraKeysRef.current.includes(cameraKey(nextCamera))) return;
    cameraRef.current = nextCamera;
    setCamera(nextCamera);
  }, [initialCamera?.pan_x, initialCamera?.pan_y, initialCamera?.zoom]);

  const selectNode = React.useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
  }, []);

  const startCanvasPan = React.useCallback((screenX: number, screenY: number) => {
    const current = cameraRef.current;
    interactionRef.current = {
      kind: 'pan',
      startScreenX: screenX,
      startScreenY: screenY,
      startPanX: current.pan_x,
      startPanY: current.pan_y,
    };
    setSelectedNodeId(null);
  }, []);

  const startNodeDrag = React.useCallback(
    (nodeId: string, screenX: number, screenY: number) => {
      if (!enableNodeDrag) return;
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) return;
      interactionRef.current = {
        kind: 'drag',
        nodeId,
        startScreenX: screenX,
        startScreenY: screenY,
        startNodeX: node.x,
        startNodeY: node.y,
      };
      setDraggedNodeId(nodeId);
      setDraggedNodePosition({ x: node.x, y: node.y });
      setSelectedNodeId(nodeId);
    },
    [enableNodeDrag, nodes],
  );

  const updateNodeDragPosition = React.useCallback((screenX: number, screenY: number) => {
    const current = interactionRef.current;
    if (current.kind === 'idle') return;

    if (current.kind === 'pan') {
      setLocalCamera({
        pan_x: current.startPanX + (screenX - current.startScreenX),
        pan_y: current.startPanY + (screenY - current.startScreenY),
        zoom: cameraRef.current.zoom,
      });
      return;
    }

    const deltaX = (screenX - current.startScreenX) / cameraRef.current.zoom;
    const deltaY = (screenY - current.startScreenY) / cameraRef.current.zoom;
    setDraggedNodePosition({
      x: current.startNodeX + deltaX,
      y: current.startNodeY + deltaY,
    });
  }, []);

  const clearInteraction = React.useCallback(() => {
    interactionRef.current = { kind: 'idle' };
    setDraggedNodeId(null);
    setDraggedNodePosition(null);
    dragEndCallbackRef.current = null;
  }, []);

  const endNodeDrag = React.useCallback(
    (callback: DragEndCallback) => {
      const current = interactionRef.current;
      if (current.kind === 'drag' && draggedNodePosition) {
        callback(current.nodeId, draggedNodePosition.x, draggedNodePosition.y);
      }
      clearInteraction();
    },
    [clearInteraction, draggedNodePosition],
  );

  /**
   * Multiply the zoom by `factor`, keeping the viewport center fixed.
   * Powers explicit zoom-in/zoom-out toolbar controls.
   */
  const zoomBy = React.useCallback(
    (factor: number) => {
      const element = canvasRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const current = cameraRef.current;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const worldX = (centerX - current.pan_x) / current.zoom;
      const worldY = (centerY - current.pan_y) / current.zoom;
      const nextZoom = clampZoom(current.zoom * factor);
      setLocalCamera({
        zoom: nextZoom,
        pan_x: centerX - worldX * nextZoom,
        pan_y: centerY - worldY * nextZoom,
      });
    },
    [canvasRef, setLocalCamera],
  );

  /**
   * Pan so the given world-space point lands at the viewport center,
   * preserving the current zoom. Powers minimap click/drag-to-jump.
   */
  const centerOnWorldPoint = React.useCallback(
    (worldX: number, worldY: number) => {
      const element = canvasRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const current = cameraRef.current;
      setLocalCamera({
        zoom: current.zoom,
        pan_x: rect.width / 2 - worldX * current.zoom,
        pan_y: rect.height / 2 - worldY * current.zoom,
      });
    },
    [canvasRef, setLocalCamera],
  );

  const zoomToFit = React.useCallback(
    (frames: Array<{ x: number; y: number; width: number; height: number }>) => {
      const element = canvasRef.current;
      if (!element || frames.length === 0) return false;

      const rect = element.getBoundingClientRect();
      if (!hasUsableViewport(rect, ZOOM_TO_FIT_PADDING)) return false;

      const minX = Math.min(...frames.map((frame) => frame.x));
      const minY = Math.min(...frames.map((frame) => frame.y));
      const maxX = Math.max(...frames.map((frame) => frame.x + frame.width));
      const maxY = Math.max(...frames.map((frame) => frame.y + frame.height));
      const width = Math.max(1, maxX - minX);
      const height = Math.max(1, maxY - minY);
      const nextZoom = clampZoom(
        Math.max(
          fitMinZoom,
          Math.min(
            ZOOM_TO_FIT_MAX,
            (rect.width - ZOOM_TO_FIT_PADDING * 2) / width,
            (rect.height - ZOOM_TO_FIT_PADDING * 2) / height,
          ),
        ),
      );

      // At the readability floor the graph may exceed the viewport. Each axis
      // is judged on its own: an axis that fits is centred, one that does not
      // anchors at the graph's start so the first steps are on screen
      // (centering would strand the user in the middle of a giant field).
      const fitsWidth = width * nextZoom <= rect.width - ZOOM_TO_FIT_PADDING * 2;
      const fitsHeight = height * nextZoom <= rect.height - ZOOM_TO_FIT_PADDING * 2;
      setLocalCamera({
        zoom: nextZoom,
        pan_x: fitsWidth
          ? rect.width / 2 - (minX + width / 2) * nextZoom
          : ZOOM_TO_FIT_PADDING - minX * nextZoom,
        pan_y: fitsHeight
          ? rect.height / 2 - (minY + height / 2) * nextZoom
          : ZOOM_TO_FIT_PADDING - minY * nextZoom,
      });
      return true;
    },
    [canvasRef, setLocalCamera, fitMinZoom],
  );

  React.useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;

    /**
     * A wheel event that begins inside scrollable CONTENT belongs to that
     * content, not the camera (the Figma/FigJam rule). Walk from the event
     * target up to the canvas: if any element in between can still scroll in
     * the wheel's dominant direction, yield — no preventDefault, no pan.
     * Pinch (ctrl/meta wheel) always belongs to the camera.
     */
    const scrollableContentClaimsWheel = (event: WheelEvent): boolean => {
      if (event.ctrlKey || event.metaKey) return false;
      let node = event.target instanceof HTMLElement ? event.target : null;
      const vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX);
      while (node && node !== element) {
        const style = window.getComputedStyle(node);
        if (vertical) {
          const scrollableY = /(auto|scroll|overlay)/.test(style.overflowY)
            && node.scrollHeight > node.clientHeight + 1;
          if (scrollableY) {
            const atTop = node.scrollTop <= 0;
            const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
            if ((event.deltaY > 0 && !atBottom) || (event.deltaY < 0 && !atTop)) return true;
          }
        } else {
          const scrollableX = /(auto|scroll|overlay)/.test(style.overflowX)
            && node.scrollWidth > node.clientWidth + 1;
          if (scrollableX) {
            const atLeft = node.scrollLeft <= 0;
            const atRight = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
            if ((event.deltaX > 0 && !atRight) || (event.deltaX < 0 && !atLeft)) return true;
          }
        }
        node = node.parentElement;
      }
      return false;
    };

    const handleWheel = (event: WheelEvent) => {
      if (scrollableContentClaimsWheel(event)) return;
      event.preventDefault();
      const current = cameraRef.current;
      const deltaPixels = wheelDeltaPixels(event, element);

      // Chromium delivers trackpad pinch as a wheel event with ctrlKey set.
      if (event.ctrlKey || event.metaKey) {
        if (!enablePinchZoom) return;
        const rect = element.getBoundingClientRect();
        const screenX = event.clientX - rect.left;
        const screenY = event.clientY - rect.top;
        const worldX = (screenX - current.pan_x) / current.zoom;
        const worldY = (screenY - current.pan_y) / current.zoom;
        const nextZoom = clampZoom(current.zoom * zoomFactorFromWheelDirection(deltaPixels.y));
        setLocalCamera({
          zoom: nextZoom,
          pan_x: screenX - worldX * nextZoom,
          pan_y: screenY - worldY * nextZoom,
        });
        return;
      }

      // Two-finger scroll = pan the world.
      if (!enableScrollPan) return;
      setLocalCamera({
        zoom: current.zoom,
        pan_x: current.pan_x - deltaPixels.x,
        pan_y: current.pan_y - deltaPixels.y,
      });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedNodeId(null);
      }
    };

    // WebKit (Safari / WKWebView — the installed-app shell) does NOT deliver
    // trackpad pinch as ctrlKey wheel events the way Chromium does. It fires
    // proprietary gesturestart/gesturechange/gestureend events carrying a
    // cumulative `scale`. Without these handlers, pinch-zoom is dead in the
    // real product even though it works in headless Chromium.
    interface WebKitGestureEvent extends Event {
      scale: number;
      clientX: number;
      clientY: number;
    }
    let gestureStartZoom = cameraRef.current.zoom;
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartZoom = cameraRef.current.zoom;
    };
    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      if (!enablePinchZoom) return;
      const gesture = event as WebKitGestureEvent;
      const rect = element.getBoundingClientRect();
      const screenX = gesture.clientX - rect.left;
      const screenY = gesture.clientY - rect.top;
      const current = cameraRef.current;
      const worldX = (screenX - current.pan_x) / current.zoom;
      const worldY = (screenY - current.pan_y) / current.zoom;
      const nextZoom = clampZoom(gestureStartZoom * gesture.scale);
      setLocalCamera({
        zoom: nextZoom,
        pan_x: screenX - worldX * nextZoom,
        pan_y: screenY - worldY * nextZoom,
      });
    };
    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
    };

    element.addEventListener('wheel', handleWheel, { passive: false });
    element.addEventListener('keydown', handleKeyDown);
    element.addEventListener('gesturestart', handleGestureStart);
    element.addEventListener('gesturechange', handleGestureChange);
    element.addEventListener('gestureend', handleGestureEnd);
    return () => {
      element.removeEventListener('wheel', handleWheel);
      element.removeEventListener('keydown', handleKeyDown);
      element.removeEventListener('gesturestart', handleGestureStart);
      element.removeEventListener('gesturechange', handleGestureChange);
      element.removeEventListener('gestureend', handleGestureEnd);
    };
  }, [canvasRef, setLocalCamera, enablePinchZoom, enableScrollPan]);

  return {
    camera,
    selectedNodeId,
    selectNode,
    draggedNodeId,
    draggedNodePosition,
    startCanvasPan,
    startNodeDrag,
    updateNodeDragPosition,
    endNodeDrag,
    zoomToFit,
    zoomBy,
    centerOnWorldPoint,
  };
}
