import { EventEmitter } from "events";
import Path from "path";
import SystemInformation from "systeminformation";
import * as UUID from "uuid";
import { Config } from "./Config";
import { FolderDeletionWatcher } from "./FolderDeletionWatcher";
import { isDirectory } from "./Functions";

/** @module MountMonitor */

const UUID_NAMESPACE = "6ba7b815-9dad-11d1-80b4-00c04fd430c8"; // Next above RFC defined namepsaces
const INTERVAL_LENGTH = 10000;

const SORT = true;

const IGNORED_MOUNT_POINTS_REGEX:{"darwin":RegExp[], "linux":RegExp[], "win32":RegExp[] } = {
    "darwin": [
            /^$/,
            /^\/private\//,
            /^\/Volumes\/Recovery$/,
            /^\/System\//
        ],
    "linux": [],
    "win32": [],
};


export type FileSystem = {
    device: string,
    label: string,
    filesystem: string,
    mount: string,
    mountpoints: {path:string, label:string}[],
    protocol: string,
    removable: boolean,
    serial: string,
    size: number,
    uuid: string,
}

export type FileSystemEvent = { filesystem: FileSystem, type: "mount"|"unmount" } | { filesystem: FileSystem, oldFilesystem: FileSystem, type: "rename" };

let deletionWatchers: {[path:string]:FolderDeletionWatcher} = {};
let intervalVar:NodeJS.Timeout|undefined = undefined;
let filesystemMap:{[key:string]:FileSystem} = {};

class _MountMonitor extends EventEmitter {

    intervalLength = INTERVAL_LENGTH;

    public constructor() {
        super();
        this._onMount.bind(this);
        this._onRename.bind(this);
        this._onUnmount.bind(this);
    }

    private _onMount( event:FileSystemEvent ):void {
        const path = event.filesystem.mountpoints[0].path;
        filesystemMap[ path ] = event.filesystem;
        deletionWatchers[ path ] = new FolderDeletionWatcher( path, () => {
            const filesystem = filesystemMap[ path ];
            if( filesystem ) {
                const event: FileSystemEvent = { filesystem, type: "unmount" };
                this.emit( "unmount",  event );
                this.emit( "all", event );
                this.emit( "change" );
            }
        } );
    }

    private _onRename( event:FileSystemEvent ):void {
        this._onUnmount( event );
        this._onMount( event );
    }

    private _onUnmount( event:FileSystemEvent ):void {
        const path = event.filesystem.mountpoints[0].path;
        delete filesystemMap[ path ];
        deletionWatchers[ path ].stop();
        delete deletionWatchers[ path ];
    }


    get state():readonly FileSystem[] { return sortFilesystems( Object.values( filesystemMap ) ); }
    set state( s:readonly FileSystem[] ) {}

    public filesystem( path:string ):FileSystem|undefined {
        return this.state
            .reduce<FileSystem|undefined>( (R,fs) => {
                if(!R || fs.mountpoints[0].path.length>R!.mountpoints[0].path.length) {
                    if( path.startsWith( fs.mountpoints[ 0 ].path ) ) {
                        return fs;
                    }
                }
                return R;
            }, undefined );
    }

    public isMounted( path:string ):boolean {
        return this.state.some(drive => drive.mountpoints[0].path===path);
    }

    public async nextRefresh():Promise<void> {
        return new Promise( resolve => this.once( "refresh", resolve ) );
    }

    public start():void {
        Config.console.log( `MountMonitor.start()` );
        if(intervalVar === undefined)
        {
            this.on( "mount", this._onMount );
            this.on( "onRename", this._onMount );
            this.on( "unmount", this._onUnmount );
            // Config.console.info("Starting MountMonitor");
            intervalFunction();
            intervalVar = setInterval(intervalFunction, INTERVAL_LENGTH);
        }
    }

    public stop():void {
        Config.console.log( `MountMonitor.stop()` );
        if(intervalVar) {
            this.removeListener( "mount", this._onMount );
            this.removeListener( "onRename", this._onMount );
            this.removeListener( "unmount", this._onUnmount );
            // Config.console.info("Stopping MountMonitor");
            clearInterval(intervalVar);
            intervalVar = undefined;
        }
    }

}

export const MountMonitor = new _MountMonitor();
MountMonitor.start();
MountMonitor.on( "all", Config.console.log );

async function intervalFunction():Promise<void>
{
    // Config.console.log( 'Polling System for block devices.' );
    const [ devices, filesystems ] = await Promise.all( [
        SystemInformation.blockDevices(),
        SystemInformation.fsSize(),
    ] );

    // Config.console.log( devices );
    // Config.console.log( filesystems );
    const filteredDevices = devices
        .filter( (dev) => IGNORED_MOUNT_POINTS_REGEX[process.platform as "darwin"|"linux"|"win32"].every( regEx => regEx.test(dev.mount)===false ) )
        .filter( (dev) => String(dev.size)!=='' )
        .filter( (dev) => dev.physical!=="Network" )
        .filter( (dev) => dev.protocol!=="Disk Image")
        // .map( (dev) => {dev.label=(dev.label===""?"Untitled":dev.label); return dev;} );

    const filteredFileSystems = filesystems
        .filter( (fs) => IGNORED_MOUNT_POINTS_REGEX[process.platform as "darwin"|"linux"|"win32"].every( regEx => regEx.test(fs.mount)===false ) )
        .filter( (fs) => String(fs.size)!=='' )
        .filter( (fs) => filteredDevices.filter( dev => dev.mount===fs.mount ).length===0 );


    const unsortedState = [
        ...filteredDevices.map<FileSystem>( (device) => ( {
            device: device.name,
            label: device.label,
            filesystem: device.fsType,
            mount: device.mount,
            mountpoints: [ {path:device.mount, label:device.label} ],
            protocol: device.protocol,
            removable: device.removable,
            serial: device.serial,
            size: device.size,
            uuid: device.uuid,
        } ) ),
        ...filteredFileSystems.map<FileSystem>( ( filesystem ) => ( {
            device: filesystem.fs,
            label: filesystem.fs.split(Path.sep).pop()!,
            filesystem: "SMB",
            mount: filesystem.mount,
            mountpoints:[ { path: filesystem.mount, label:filesystem.fs.split(Path.sep).pop()! } ],
            protocol: "SMB",
            removable: true,
            serial: "",
            size: filesystem.size,
            uuid: UUID.v5( filesystem.fs, UUID_NAMESPACE ),
        } ) ),
    ];

    // Config.console.log( "MOUNTMONITOR: unsortedState=%j", unsortedState );

    const newState = sortFilesystems( unsortedState );

    // Config.console.log( "MOUNTMONITOR: newState=%j", newState );

    const events:FileSystemEvent[] = [];

    const uuidFilesystemMap:{[uuid:string]:FileSystem} = newState.reduce( ( R, fs ) => ( { ...R, [ fs.uuid ]: fs } ) , {} );

    await Promise.all(
        newState.map( async ( filesystem:FileSystem )=> {
            const path = filesystem.mountpoints[0].path;
            const oldFilesystem = filesystemMap[ path ];
            if( await isDirectory( path ) && oldFilesystem===undefined ) {
                events.push( { filesystem, type: "mount" } );
            }
        } )
    );

    MountMonitor.state.forEach( ( oldFilesystem ) => {
        const filesystem = uuidFilesystemMap[ oldFilesystem.uuid ];
        if( filesystem===undefined ) {
            events.push( { filesystem:oldFilesystem, type: "unmount" } );
        } else if(filesystem.label!==oldFilesystem.label) {
            events.push( { filesystem, oldFilesystem, type: "rename" } );
        }
    } );

    events.forEach( ( event ) => {
        MountMonitor.emit( event.type, event );
        MountMonitor.emit( "all", event );
    } );
    MountMonitor.emit( "changed" );
    MountMonitor.emit( "refresh" );
}

function sortFilesystems( filesystems:FileSystem[] ) {
    if(!SORT) return filesystems;
    switch(process.platform)
    {
        case "darwin":
            return filesystems.sort( ( a, b ) => {
                const aLabel = a.label===""?"Untitled":a.label;
                const bLabel = b.label===""?"Untitled":b.label;
                return aLabel.toUpperCase().localeCompare(bLabel.toUpperCase())
            } );

        case "linux":
        case "win32":
        default:
            return filesystems.sort( ( a, b ) => {
                const aPath = a.mountpoints[0].path;
                const bPath = b.mountpoints[0].path;
                return aPath.toUpperCase().localeCompare(bPath.toUpperCase())
            } );
    }

}