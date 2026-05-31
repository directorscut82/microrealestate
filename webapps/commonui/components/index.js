// Placeholder kept because Dockerfile (webapps/landlord/Dockerfile:21
// and webapps/tenant/Dockerfile if applicable) COPIES this directory.
// Removing the directory breaks the Docker build cache key.
//
// All previously-shared components have moved to webapps/landlord/src
// and webapps/tenant/src. This file exists ONLY to keep the directory
// tree intact for the build context.
export {};
