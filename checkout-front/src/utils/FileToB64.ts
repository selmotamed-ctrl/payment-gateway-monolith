export function fileToBase64Url(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            // result = "data:<mime>;base64,AAAA..."
            resolve(reader.result as string);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}
export async function fileToBase64(file: File): Promise<string> {
    const b64 = await fileToBase64Url(file);
    const pureB64 = b64.split(",")[1]!;

    return pureB64 || "";
}
