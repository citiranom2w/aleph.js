use crate::import_map::{ImportHashMap, ImportMap};

use indexmap::IndexSet;
use path_slash::PathBufExt;
use pathdiff::diff_paths;
use regex::Regex;
use relative_path::RelativePath;
use serde::Serialize;
use std::{
  collections::HashMap,
  path::{Path, PathBuf},
  str::FromStr,
};
use url::Url;

lazy_static! {
  pub static ref HASH_PLACEHOLDER: String = "x".repeat(9);
  pub static ref RE_ENDS_WITH_VERSION: Regex = Regex::new(
    r"@\d+(\.\d+){0,2}(\-[a-z0-9]+(\.[a-z0-9]+)?)?$"
  )
  .unwrap();
  pub static ref RE_REACT_URL: Regex = Regex::new(
    r"^https?://(esm.sh/|cdn.esm.sh/v\d+/|esm.x-static.io/v\d+/|jspm.dev/|cdn.skypack.dev/|jspm.dev/npm:|esm.run/)react(\-dom)?(@[\^|~]{0,1}[0-9a-z\.\-]+)?([/|\?].*)?$"
  )
  .unwrap();
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyDescriptor {
  pub specifier: String,
  pub is_dynamic: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineStyle {
  pub r#type: String,
  pub quasis: Vec<String>,
  pub exprs: Vec<String>,
}

/// A Resolver to resolve aleph.js import/export URL.
pub struct Resolver {
  /// the text specifier associated with the import/export statement.
  pub specifier: String,
  /// a flag indicating if the specifier is remote url or not.
  pub specifier_is_remote: bool,
  /// builtin jsx tags like `a`, `link`, `head`, etc
  pub used_builtin_jsx_tags: IndexSet<String>,
  /// dependency graph
  pub dep_graph: Vec<DependencyDescriptor>,
  /// inline styles
  pub inline_styles: HashMap<String, InlineStyle>,
  /// bundle mode
  pub bundle_mode: bool,
  /// bundled modules
  pub bundled_modules: IndexSet<String>,

  // private
  import_map: ImportMap,
  aleph_pkg_uri: Option<String>,
  react_version: Option<String>,
}

impl Resolver {
  pub fn new(
    specifier: &str,
    import_map: ImportHashMap,
    aleph_pkg_uri: Option<String>,
    react_version: Option<String>,
    bundle_mode: bool,
    bundled_modules: Vec<String>,
  ) -> Self {
    let mut set = IndexSet::<String>::new();
    for url in bundled_modules {
      set.insert(url);
    }
    Resolver {
      specifier: specifier.into(),
      specifier_is_remote: is_remote_url(specifier),
      used_builtin_jsx_tags: IndexSet::new(),
      dep_graph: Vec::new(),
      inline_styles: HashMap::new(),
      import_map: ImportMap::from_hashmap(import_map),
      aleph_pkg_uri,
      react_version,
      bundle_mode,
      bundled_modules: set,
    }
  }

  pub fn get_aleph_pkg_uri(&self) -> String {
    if let Some(aleph_pkg_uri) = &self.aleph_pkg_uri {
      return aleph_pkg_uri.into();
    }
    "https://deno.land/x/aleph".into()
  }

  /// fix import/export url.
  //  - `https://esm.sh/react` -> `/-/esm.sh/react.js`
  //  - `https://esm.sh/react@17.0.1?target=es2015&dev` -> `/-/esm.sh/react@17.0.1_target=es2015&dev.js`
  //  - `http://localhost:8080/mod` -> `/-/http_localhost_8080/mod.js`
  //  - `/components/logo.tsx` -> `/components/logo.tsx`
  //  - `../components/logo.tsx` -> `../components/logo.tsx`
  //  - `./button.tsx` -> `./button.tsx`
  //  - `/components/foo/./logo.tsx` -> `/components/foo/logo.tsx`
  //  - `/components/foo/../logo.tsx` -> `/components/logo.tsx`
  pub fn fix_import_url(&self, url: &str) -> String {
    let is_remote = is_remote_url(url);
    if !is_remote {
      let mut url = url;
      let mut root = Path::new("");
      if url.starts_with("./") {
        url = url.trim_start_matches(".");
        root = Path::new(".");
      } else if url.starts_with("../") {
        url = url.trim_start_matches("..");
        root = Path::new("..");
      }
      return RelativePath::new(url)
        .normalize()
        .to_path(root)
        .to_slash()
        .unwrap()
        .to_owned();
    }
    let url = Url::from_str(url).unwrap();
    let path = Path::new(url.path());
    let mut path_buf = path.to_owned();
    let mut ext = ".".to_owned();
    ext.push_str(match path.extension() {
      Some(os_str) => match os_str.to_str() {
        Some(s) => {
          if RE_ENDS_WITH_VERSION.is_match(url.path()) {
            "js"
          } else {
            s
          }
        }
        None => "js",
      },
      None => "js",
    });
    match path.file_name() {
      Some(os_str) => match os_str.to_str() {
        Some(s) => {
          let mut file_name = s.trim_end_matches(ext.as_str()).to_owned();
          match url.query() {
            Some(q) => {
              file_name.push('_');
              file_name.push_str(q);
            }
            _ => {}
          };
          file_name.push_str(ext.as_str());
          path_buf.set_file_name(file_name);
        }
        _ => {}
      },
      _ => {}
    };
    let mut p = "/-/".to_owned();
    if url.scheme() == "http" {
      p.push_str("http_");
    }
    p.push_str(url.host_str().unwrap());
    match url.port() {
      Some(port) => {
        p.push('_');
        p.push_str(port.to_string().as_str());
      }
      _ => {}
    }
    p.push_str(path_buf.to_str().unwrap());
    p
  }

  /// resolve import/export url.
  // [/pages/index.tsx]
  // - `https://esm.sh/swr` -> `/-/esm.sh/swr.js`
  // - `https://esm.sh/react` -> `/-/esm.sh/react@${REACT_VERSION}.js`
  // - `https://deno.land/x/aleph/mod.ts` -> `/-/deno.land/x/aleph@v${CURRENT_ALEPH_VERSION}/mod.ts`
  // - `../components/logo.tsx` -> `/components/logo.{HASH}.js`
  // - `../styles/app.css` -> `/styles/app.css.{HASH}.js`
  // - `@/components/logo.tsx` -> `/components/logo.{HASH}.js`
  // - `~/components/logo.tsx` -> `/components/logo.{HASH}.js`
  pub fn resolve(&mut self, url: &str, is_dynamic: bool, rel: Option<String>) -> (String, String) {
    // apply import map
    let url = self.import_map.resolve(self.specifier.as_str(), url);
    let mut fixed_url: String = if is_remote_url(url.as_str()) {
      url.into()
    } else {
      if self.specifier_is_remote {
        let mut new_url = Url::from_str(self.specifier.as_str()).unwrap();
        if url.starts_with("/") {
          new_url.set_path(url.as_str());
        } else {
          let mut buf = PathBuf::from(new_url.path());
          buf.pop();
          buf.push(url);
          let path = "/".to_owned()
            + RelativePath::new(buf.to_slash().unwrap().as_str())
              .normalize()
              .as_str();
          new_url.set_path(path.as_str());
        }
        new_url.as_str().into()
      } else {
        if url.starts_with("/") {
          url.into()
        } else if url.starts_with("@/") {
          url.trim_start_matches("@").into()
        } else if url.starts_with("~/") {
          url.trim_start_matches("~").into()
        } else {
          let mut buf = PathBuf::from(self.specifier.as_str());
          buf.pop();
          buf.push(url);
          "/".to_owned()
            + RelativePath::new(buf.to_slash().unwrap().as_str())
              .normalize()
              .as_str()
        }
      }
    };
    // fix deno.land/x/aleph url
    if let Some(aleph_pkg_uri) = &self.aleph_pkg_uri {
      if fixed_url.starts_with("https://deno.land/x/aleph/") {
        fixed_url = format!(
          "{}/{}",
          aleph_pkg_uri.as_str(),
          fixed_url.trim_start_matches("https://deno.land/x/aleph/")
        );
      }
    }
    // fix react/react-dom url
    if let Some(version) = &self.react_version {
      if RE_REACT_URL.is_match(fixed_url.as_str()) {
        let caps = RE_REACT_URL.captures(fixed_url.as_str()).unwrap();
        let mut host = caps.get(1).map_or("", |m| m.as_str());
        let non_esm_sh_cdn = !host.starts_with("esm.sh/")
          && !host.starts_with("cdn.esm.sh/")
          && !host.starts_with("esm.x-static.io/");
        if non_esm_sh_cdn {
          host = "esm.sh/"
        }
        let pkg = caps.get(2).map_or("", |m| m.as_str());
        let ver = caps.get(3).map_or("", |m| m.as_str());
        let path = caps.get(4).map_or("", |m| m.as_str());
        if non_esm_sh_cdn || ver != version {
          fixed_url = format!("https://{}react{}@{}{}", host, pkg, version, path);
        }
      }
    }
    let is_remote = is_remote_url(fixed_url.as_str());
    let mut resolved_path = if is_remote {
      if self.specifier_is_remote {
        let mut buf = PathBuf::from(self.fix_import_url(self.specifier.as_str()));
        buf.pop();
        diff_paths(
          self.fix_import_url(fixed_url.as_str()),
          buf.to_slash().unwrap(),
        )
        .unwrap()
      } else {
        let mut buf = PathBuf::from(self.specifier.as_str());
        buf.pop();
        diff_paths(
          self.fix_import_url(fixed_url.as_str()),
          buf.to_slash().unwrap(),
        )
        .unwrap()
      }
    } else {
      if self.specifier_is_remote {
        let mut new_url = Url::from_str(self.specifier.as_str()).unwrap();
        if fixed_url.starts_with("/") {
          new_url.set_path(fixed_url.as_str());
        } else {
          let mut buf = PathBuf::from(new_url.path());
          buf.pop();
          buf.push(fixed_url.as_str());
          let path = "/".to_owned()
            + RelativePath::new(buf.to_slash().unwrap().as_str())
              .normalize()
              .as_str();
          new_url.set_path(path.as_str());
        }
        let mut buf = PathBuf::from(self.fix_import_url(self.specifier.as_str()));
        buf.pop();
        diff_paths(
          self.fix_import_url(new_url.as_str()),
          buf.to_slash().unwrap(),
        )
        .unwrap()
      } else {
        if fixed_url.starts_with("/") {
          let mut buf = PathBuf::from(self.specifier.as_str());
          buf.pop();
          diff_paths(fixed_url.clone(), buf.to_slash().unwrap()).unwrap()
        } else {
          PathBuf::from(fixed_url.clone())
        }
      }
    };
    // fix extension & add hash placeholder
    match resolved_path.extension() {
      Some(os_str) => match os_str.to_str() {
        Some(s) => match s {
          "js" | "jsx" | "ts" | "tsx" | "mjs" => {
            let mut filename = resolved_path
              .file_name()
              .unwrap()
              .to_str()
              .unwrap()
              .trim_end_matches(s)
              .to_owned();
            if !is_remote && !self.specifier_is_remote {
              filename.push_str(HASH_PLACEHOLDER.as_str());
              filename.push('.');
            }
            filename.push_str("js");
            resolved_path.set_file_name(filename);
          }
          _ => {
            if !is_remote && !self.specifier_is_remote {
              let mut filename = resolved_path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
              filename.push('.');
              filename.push_str(HASH_PLACEHOLDER.as_str());
              filename.push_str(".js");
              resolved_path.set_file_name(filename);
            }
          }
        },
        None => {}
      },
      None => {}
    };
    let update_dep_graph = match rel {
      Some(ref rel) => !rel.eq("."),
      None => true,
    };
    if update_dep_graph {
      self.dep_graph.push(DependencyDescriptor {
        specifier: fixed_url.clone(),
        is_dynamic,
      });
    }
    let path = resolved_path.to_slash().unwrap();
    if !path.starts_with("./") && !path.starts_with("../") && !path.starts_with("/") {
      return (format!("./{}", path), fixed_url);
    }
    (path, fixed_url)
  }
}

pub fn is_remote_url(url: &str) -> bool {
  return url.starts_with("https://") || url.starts_with("http://");
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::import_map::ImportHashMap;
  use std::collections::HashMap;

  #[test]
  fn resolver_fix_import_url() {
    let resolver = Resolver::new(
      "/app.tsx",
      ImportHashMap::default(),
      None,
      None,
      false,
      vec![],
    );
    assert_eq!(
      resolver.fix_import_url("https://esm.sh/react"),
      "/-/esm.sh/react.js"
    );
    assert_eq!(
      resolver.fix_import_url("https://esm.sh/react@17.0.1?target=es2015&dev"),
      "/-/esm.sh/react@17.0.1_target=es2015&dev.js"
    );
    assert_eq!(
      resolver.fix_import_url("http://localhost:8080/mod"),
      "/-/http_localhost_8080/mod.js"
    );
    assert_eq!(
      resolver.fix_import_url("/components/foo/./logo.tsx"),
      "/components/foo/logo.tsx"
    );
    assert_eq!(
      resolver.fix_import_url("/components/foo/../logo.tsx"),
      "/components/logo.tsx"
    );
    assert_eq!(
      resolver.fix_import_url("/components/../foo/logo.tsx"),
      "/foo/logo.tsx"
    );
    assert_eq!(
      resolver.fix_import_url("/components/logo.tsx"),
      "/components/logo.tsx"
    );
    assert_eq!(
      resolver.fix_import_url("../components/logo.tsx"),
      "../components/logo.tsx"
    );
    assert_eq!(resolver.fix_import_url("./button.tsx"), "./button.tsx");
  }

  #[test]
  fn resolve_local() {
    let mut imports: HashMap<String, String> = HashMap::new();
    imports.insert("@/".into(), "./".into());
    imports.insert("~/".into(), "./".into());
    imports.insert("react".into(), "https://esm.sh/react".into());
    imports.insert("react-dom/".into(), "https://esm.sh/react-dom/".into());
    imports.insert(
      "https://deno.land/x/aleph/".into(),
      "http://localhost:2020/".into(),
    );
    let mut resolver = Resolver::new(
      "/pages/index.tsx",
      ImportHashMap {
        imports,
        scopes: HashMap::new(),
      },
      None,
      Some("17.0.1".into()),
      false,
      vec![],
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react", false, None),
      (
        "../-/esm.sh/react@17.0.1.js".into(),
        "https://esm.sh/react@17.0.1".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-refresh", false, None),
      (
        "../-/esm.sh/react-refresh.js".into(),
        "https://esm.sh/react-refresh".into()
      )
    );
    assert_eq!(
      resolver.resolve(
        "https://deno.land/x/aleph/framework/react/link.ts",
        false,
        None
      ),
      (
        "../-/http_localhost_2020/framework/react/link.js".into(),
        "http://localhost:2020/framework/react/link.ts".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react@16", false, None),
      (
        "../-/esm.sh/react@17.0.1.js".into(),
        "https://esm.sh/react@17.0.1".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom", false, None),
      (
        "../-/esm.sh/react-dom@17.0.1.js".into(),
        "https://esm.sh/react-dom@17.0.1".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom@16.14.0", false, None),
      (
        "../-/esm.sh/react-dom@17.0.1.js".into(),
        "https://esm.sh/react-dom@17.0.1".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom/server", false, None),
      (
        "../-/esm.sh/react-dom@17.0.1/server.js".into(),
        "https://esm.sh/react-dom@17.0.1/server".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://esm.sh/react-dom@16.13.1/server", false, None),
      (
        "../-/esm.sh/react-dom@17.0.1/server.js".into(),
        "https://esm.sh/react-dom@17.0.1/server".into()
      )
    );
    assert_eq!(
      resolver.resolve("react-dom/server", false, None),
      (
        "../-/esm.sh/react-dom@17.0.1/server.js".into(),
        "https://esm.sh/react-dom@17.0.1/server".into()
      )
    );
    assert_eq!(
      resolver.resolve("react", false, None),
      (
        "../-/esm.sh/react@17.0.1.js".into(),
        "https://esm.sh/react@17.0.1".into()
      )
    );
    assert_eq!(
      resolver.resolve("https://deno.land/x/aleph/mod.ts", false, None),
      (
        "../-/http_localhost_2020/mod.js".into(),
        "http://localhost:2020/mod.ts".into()
      )
    );
    assert_eq!(
      resolver.resolve("../components/logo.tsx", false, None),
      (
        format!("../components/logo.{}.js", HASH_PLACEHOLDER.as_str()),
        "/components/logo.tsx".into()
      )
    );
    assert_eq!(
      resolver.resolve("../styles/app.css", false, None),
      (
        format!("../styles/app.css.{}.js", HASH_PLACEHOLDER.as_str()),
        "/styles/app.css".into()
      )
    );
    assert_eq!(
      resolver.resolve("@/components/logo.tsx", false, None),
      (
        format!("../components/logo.{}.js", HASH_PLACEHOLDER.as_str()),
        "/components/logo.tsx".into()
      )
    );
    assert_eq!(
      resolver.resolve("~/components/logo.tsx", false, None),
      (
        format!("../components/logo.{}.js", HASH_PLACEHOLDER.as_str()),
        "/components/logo.tsx".into()
      )
    );
  }

  #[test]
  fn resolve_remote_1() {
    let mut resolver = Resolver::new(
      "https://esm.sh/react-dom",
      ImportHashMap::default(),
      None,
      Some("17.0.1".into()),
      false,
      vec![],
    );
    assert_eq!(
      resolver.resolve(
        "https://cdn.esm.sh/react@17.0.1/es2020/react.js",
        false,
        None
      ),
      (
        "../cdn.esm.sh/react@17.0.1/es2020/react.js".into(),
        "https://cdn.esm.sh/react@17.0.1/es2020/react.js".into()
      )
    );
    assert_eq!(
      resolver.resolve("./react", false, None),
      (
        "./react@17.0.1.js".into(),
        "https://esm.sh/react@17.0.1".into()
      )
    );
    assert_eq!(
      resolver.resolve("/react", false, None),
      (
        "./react@17.0.1.js".into(),
        "https://esm.sh/react@17.0.1".into()
      )
    );
  }

  #[test]
  fn resolve_remote_2() {
    let mut resolver = Resolver::new(
      "https://esm.sh/preact/hooks",
      ImportHashMap::default(),
      None,
      None,
      false,
      vec![],
    );
    assert_eq!(
      resolver.resolve(
        "https://cdn.esm.sh/preact@10.5.7/es2020/preact.js",
        false,
        None
      ),
      (
        "../../cdn.esm.sh/preact@10.5.7/es2020/preact.js".into(),
        "https://cdn.esm.sh/preact@10.5.7/es2020/preact.js".into()
      )
    );
    assert_eq!(
      resolver.resolve("../preact", false, None),
      ("../preact.js".into(), "https://esm.sh/preact".into())
    );
    assert_eq!(
      resolver.resolve("/preact", false, None),
      ("../preact.js".into(), "https://esm.sh/preact".into())
    );
  }
}
