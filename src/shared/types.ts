
export type CodecksUser = {
    id?: string | number;
    name?: string;
    fullName?: string;
};

export type CodecksEntity = Record<string, unknown> & {
    id?: string | number;
    title?: string;
    name?: string;
    fullName?: string;
};
