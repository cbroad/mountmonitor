import FS from "fs";

type config = {
    console:Console;
    Debug: boolean;
    FS:any;
};

export const Config:config = {
    console: console,
    Debug: true,
    FS: FS,
};