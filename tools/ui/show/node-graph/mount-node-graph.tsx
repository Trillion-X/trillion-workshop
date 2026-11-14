import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {NodeGraph, type NodeGraphProps} from './NodeGraph';

export type MountedNodeGraph = {
  update(next: NodeGraphProps): void;
  destroy(): void;
};

export function mountNodeGraph(host: HTMLElement, initial: NodeGraphProps): MountedNodeGraph {
  const root=createRoot(host);
  let current=initial,destroyed=false;
  const render=()=>{if(!destroyed)flushSync(()=>root.render(<NodeGraph {...current}/>));};
  render();
  return {
    update(next){current=next;render();},
    destroy(){if(destroyed)return;destroyed=true;root.unmount();},
  };
}
