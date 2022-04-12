import FS from "fs";
import Path from "path";

import { AbortController } from "node-abort-controller";

import { Config } from "./Config";

const DEBUG = false;

const METHODS = {
    INTERVAL: "Interval",
    PARENT:"Parent",
};

const METHOD = METHODS.PARENT;

const POLLING_INTERVAL = 5000;

type SharedContextPromise<T> = {
    promise:Promise<T>;
    reject: (reason:any)=>void;
    resolve: (value?:T)=>void;
};


export class FolderDeletionWatcher {

    public  _callback:()=>void;
    public _path:string;
    public _abortController:AbortController|undefined;

    constructor( path:string, callback:()=>void ) {
        this._path = path;
        this._callback = callback;
        this._abortController = undefined;
        this.start();
    }

    static watch( path:string, callback:()=>void ):FolderDeletionWatcher {
        return new FolderDeletionWatcher( path, callback );
    }

    stop() {
        if( this._abortController !== undefined ) {
            this._abortController.abort();
            this._abortController = undefined;
        }
    }


    async start():Promise<void> {
        if( this._abortController === undefined ) {
            this._abortController = new AbortController();
            if( await isDirectory( this._path ) ) {
                if( METHOD===METHODS.PARENT ) {
                    this._startParent( this._path, this._callback );
                } else {
                    this._startInterval( this._path, this._callback );
                }
            } else {
                this.stop();
            }
        }
    }

    // This periodically checks to see if a folder is still there.
    // Pros: works when fs is unmounted
    // Cons: slower to report folder deletion
    public _startInterval( path:string, callback:()=>void ) {
        const statInterval = setInterval( async () => {
                if( await isDirectory( path ) ) {
                    this.stop();
                    callback();
                }
            } , POLLING_INTERVAL );
        
        const signal = this._abortController?.signal;

        signal?.addEventListener( "abort", cleanup );
        
        function cleanup() {
            clearInterval( statInterval );
            signal?.removeEventListener( "abort", cleanup );
        }
    }

    
    // This watches all parent directories of the targeted folder to see if they are deleted from their parent
    // Pros: faster, no interval function needed
    // Cons: won'd detect fs being unmounted
    public _startParent ( path:string, callback:()=>void, sharedContext:SharedContextPromise<void>|undefined = undefined ) {
        const parentPath = Path.dirname( path );
        const filename = Path.basename( path );
        if( path===parentPath ) {
            return;
        }
        if( sharedContext === undefined ) {
            sharedContext = createSharedContext();
            sharedContext.promise.then( () => { 
                    this.stop();
                    callback();
                } );
        }
        this._startParent( parentPath, callback, sharedContext ); // Set up recursively to catch and parent changes
        DEBUG && console.log( "Setup: %j", path )
        let watcher = FS.watch( parentPath, async ( event:string, affectedFile:string ) => {
            if( event==="rename" && affectedFile===filename ) {
                sharedContext!.resolve();
            }
        } );

        const signal = this._abortController?.signal;

        signal?.addEventListener( "abort", cleanup );

        function cleanup() {
            watcher.close();
            signal?.removeEventListener( "abort", cleanup );
        }
    }    

}

async function isDirectory( path:string ) {
    return Config.FS.promises.stat( path )
        .then( ( stats:FS.Stats ) => stats.isDirectory() )
        .catch( ( err:any ) => false );
}

function createSharedContext():SharedContextPromise<void> {
    let res:(value:void|PromiseLike<void>)=>void = ()=>{};
    let rej:(reason:any)=>void = ()=>{};

    const sharedContext:SharedContextPromise<void> = {
        promise: new Promise<void>( ( resolve, reject ) => {
            res = resolve;
            rej = reject;
        } ),
        resolve:()=>{},
        reject:()=>{},
    };
    sharedContext.resolve = res;
    sharedContext.reject = rej;
    return sharedContext;
}