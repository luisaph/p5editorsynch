# p5editorsynch

A Github action that sync local p5 sketches to a collections at the p5.js web editor.

## Inputs

- **`p5-username` & `p5-password`**

  **Required** Web editor's login credentials

- **`sketch-folder`**

  The local folder that holds the sketches. Default `sketches/`.

- **`collection-name`**

  The name fot the remote collection at web editor. Default `My Sketches`.

## Example usage

```yaml
- name: Sync p5
  uses: luisaph/p5editorsynch@main
  with:
    p5-username: ${{ secrets.P5_USERNAME }}
    p5-password: ${{ secrets.P5_PASSWORD }}
    sketch-folder: projects/ # Optional
    collection-name: My favorite sketches # Optional
```
