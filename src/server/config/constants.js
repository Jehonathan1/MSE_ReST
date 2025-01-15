const ResourceTypes = {
    TEMPLATE: {
        COLLECTION: 'template_collection',
        MODEL: 'element_model',
        ENTRY: 'template_entry'
    },
    PROFILE: {
        COLLECTION: 'profile_collection',
        ENTRY: 'profile_entry'
    },
    ELEMENT: {
        COLLECTION: 'element_collection',
        ENTRY: 'element_entry'
    }
};

const ContentTypes = {
    ATOM_ENTRY: 'application/atom+xml;type=entry',
    ATOM_FEED: 'application/atom+xml',
    VDF_ELEMENT: 'application/vnd.vizrt.payload+xml;type=element',
    VDF_PLAYLIST: 'application/vnd.vizrt.payload+xml;type=playlist',
    TEMPLATE_MODEL: 'application/vnd.vizrt.model+xml',
    PLAIN_TEXT: 'text/plain'
};

const MSE_BASE_URL = 'http://127.0.0.1:8580';

const ProfileCommands = {
    INITIALIZE: 'initialize',
    TAKE: 'take',
    CONTINUE: 'continue',
    OUT: 'out',
    CLEANUP: 'cleanup'
};

module.exports = {
    ResourceTypes,
    ContentTypes,
    MSE_BASE_URL,
    ProfileCommands
};