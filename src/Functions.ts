import { AbortSignal } from "node-abort-controller";

import { Config } from "./Config";

export async function exists( path:string ):Promise<boolean> {
    try {
        await Config.FS.promises.lstat( path );
        return true;
    } catch( err:any ) {
        if( ( err as NodeJS.ErrnoException ).code==="ENOENT" ) {
            return false;
        }
        throw err;
    }
}

export async function isDirectory( path:string ):Promise<boolean> {
    try {
        const stats = await Config.FS.promises.lstat( path );
        return stats.isDirectory();
    } catch( err:any ) {
        if( ( err as NodeJS.ErrnoException ).code==="ENOENT" ) {
            return false;
        }
        throw err;
    }
}

export function removeFromList<T>( list:T[], value:T ):boolean {
    const idx:number = list.indexOf( value );
    if(idx===-1) {
        return false;
    }
    list.splice( idx, 1 );
    return true;
}

export async function sleep( ms:number ):Promise<void>;
export async function sleep( ms:number, signal:AbortSignal|undefined ):Promise<void>;
export async function sleep( ms:number, signal?:AbortSignal ):Promise<void> {
    let resolve:(value:void|PromiseLike<void>)=>void|undefined;
    const promise = new Promise<void>( res => resolve = res );
    const timeout = setTimeout( resolve!, ms )
    if( signal ) {
        signal.addEventListener( "abort", onAbort );
        promise.then( () => { signal.removeEventListener( "abort", onAbort ); } );
    }
    return promise;

    function onAbort() {
        clearTimeout( timeout! );
        resolve();
    }
}